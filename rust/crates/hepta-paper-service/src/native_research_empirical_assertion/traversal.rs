//! Held filesystem traversal, exact body/artifact extraction and namespace guards.
use super::syntax::{Marker, fixed_prose, inside, prose_patterns, safe_section, strip_comment};
use super::*;
pub(super) struct Reader<'a, 'b> {
    pub(super) source: &'a mut SourceObservation<'b>,
    pub(super) context: &'a mut NativeResearchReadContextV1<'b>,
    pub(super) work: &'a LatexSyntaxControlV1<'b>,
    pub(super) claim_ranges: &'a [Value],
    pub(super) maximum_files: usize,
    pub(super) visited: BTreeSet<String>,
    pub(super) active: BTreeSet<String>,
    pub(super) files: Vec<Value>,
    pub(super) assertions: Vec<Value>,
    pub(super) presentations: Vec<Value>,
    pub(super) supports: Vec<Value>,
    pub(super) surfaces: Vec<Value>,
    pub(super) blockers: Vec<Value>,
    pub(super) path_bytes: usize,
    pub(super) include_bytes: usize,
}
impl Reader<'_, '_> {
    pub(super) fn all(&self) -> impl Iterator<Item = &Value> {
        self.files
            .iter()
            .chain(&self.assertions)
            .chain(&self.presentations)
            .chain(&self.supports)
            .chain(&self.surfaces)
            .chain(&self.blockers)
    }
    pub(super) fn check(&self) -> Result<(), String> {
        check(self.context.cancelled(), self.context.deadline())
    }
    pub(super) fn blocker(&mut self, value: String) -> Result<(), String> {
        let value = Value::String(value);
        budget(self.all().chain([&value]))?;
        self.blockers.push(value);
        Ok(())
    }
    pub(super) fn render_support(&mut self) -> Result<(), String> {
        let collator = ProductionCollationV1::load().map_err(|_| refused())?;
        let mut pending = vec![(PathBuf::new(), 0usize)];
        let mut seen = 0usize;
        while let Some((directory, depth)) = pending.pop() {
            self.check()?;
            if depth > 8 {
                self.blocker("empirical_assertion_render_support_depth_exceeded".into())?;
                continue;
            }
            let mut entries = self.source.inventory_entries(&directory)?;
            entries.sort_by(|a, b| collator.compare(&a.name, &b.name));
            for entry in entries {
                self.check()?;
                seen += 1;
                if seen > 2048 {
                    return self
                        .blocker("empirical_assertion_render_support_limit_exceeded".into());
                }
                let path = directory.join(&entry.name);
                let text = path.to_str().ok_or_else(refused)?;
                if text.len() > 4096 {
                    return Err(refused());
                }
                if entry.symlink {
                    self.blocker(format!(
                        "empirical_assertion_render_support_symlink_forbidden:{text}"
                    ))?
                } else if entry.directory {
                    pending.push((path, depth + 1))
                } else if entry.regular
                    && entry.name.rsplit_once('.').is_some_and(|(_, ext)| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "sty" | "cls" | "bib" | "bst"
                        )
                    })
                {
                    self.blocker(format!(
                        "empirical_assertion_render_support_file_forbidden:{text}"
                    ))?
                }
            }
        }
        Ok(())
    }
    fn artifact(&mut self, declaration: &Value) -> Result<Value, String> {
        if declaration["artifactPath"].is_null() {
            return Ok(Value::Null);
        }
        let relative = declaration["artifactPath"].as_str().ok_or_else(refused)?;
        let id = declaration["surfaceId"].as_str().ok_or_else(refused)?;
        let path = Path::new(relative);
        let Some(metadata) = self.source.inventory_probe(path)? else {
            self.blocker(format!("empirical_presentation_artifact_unreadable:{id}"))?;
            return Ok(
                json!({"status":"empirical_presentation_artifact_blocked","path":relative,"hash":null,"bytes":null}),
            );
        };
        if metadata.directory {
            self.blocker(format!("empirical_presentation_artifact_unreadable:{id}"))?;
            return Ok(
                json!({"status":"empirical_presentation_artifact_blocked","path":relative,"hash":null,"bytes":null}),
            );
        }
        if metadata.size > 1024 * 1024 || metadata.link_count != 1 {
            return Err(refused());
        }
        self.context.charge(self.source, path)?;
        let bytes = self.source.inventory_document(path, 1024 * 1024)?;
        self.check()?;
        let digest = bytes_hash(&bytes);
        let matched = declaration["artifactHash"] == digest;
        if !matched {
            self.blocker(format!(
                "empirical_presentation_artifact_hash_mismatch:{id}"
            ))?
        }
        Ok(
            json!({"status":if matched{"empirical_presentation_artifact_verified"}else{"empirical_presentation_artifact_blocked"},"path":relative,"hash":digest,"bytes":bytes.len()}),
        )
    }
    fn extract(
        &mut self,
        kind: Marker,
        relative: &str,
        content: &[u8],
        digest: &str,
    ) -> Result<Vec<Value>, String> {
        let units = content.iter().map(|b| u16::from(*b)).collect::<Vec<_>>();
        let lines = line_records(&units, self.context.cancelled(), self.context.deadline())?;
        let (begin_pattern, end_pattern) = kind.patterns()?;
        let mut open: Option<(Value, usize, usize)> = None;
        let mut result = Vec::new();
        let prefix = kind.prefix();
        for line in lines {
            self.check()?;
            let begin = begin_pattern.captures(&line.text);
            let end = end_pattern.captures(&line.text);
            if (line.text.contains(&format!("{}_BEGIN", kind.token()))
                || line.text.contains(&format!("{}_END", kind.token())))
                && begin.is_none()
                && end.is_none()
            {
                self.blocker(format!(
                    "{prefix}_marker_malformed:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            }
            if let Some(begin) = begin {
                if open.is_some() {
                    self.blocker(format!(
                        "{prefix}_marker_nested:{relative}:{}",
                        line.byte_start
                    ))?;
                    continue;
                }
                let declaration = parse(
                    begin.get(1).ok_or_else(refused)?.as_str(),
                    self.context.cancelled(),
                )?;
                if declaration
                    .as_ref()
                    .map(|v| kind.valid(v, self.context.cancelled(), self.context.deadline()))
                    .transpose()?
                    .unwrap_or(false)
                {
                    let declaration = declaration.ok_or_else(refused)?;
                    budget(self.all().chain(result.iter()).chain([&declaration]))?;
                    open = Some((declaration, line.byte_start, line.byte_end))
                } else {
                    self.blocker(format!(
                        "{prefix}_declaration_invalid:{relative}:{}",
                        line.byte_start
                    ))?
                }
                continue;
            }
            let Some(end) = end else { continue };
            let Some((declaration, start, body_start)) = open.take() else {
                self.blocker(format!(
                    "{prefix}_marker_end_unpaired:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            };
            if declaration[kind.id()].as_str() != Some(end.get(1).ok_or_else(refused)?.as_str()) {
                self.blocker(format!(
                    "{prefix}_marker_id_mismatch:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            }
            let range = trim_range(
                &units,
                body_start,
                line.byte_start,
                self.context.cancelled(),
                self.context.deadline(),
            )?;
            let bytes = &content[range.byte_start..range.byte_end];
            let Ok(text) = std::str::from_utf8(bytes) else {
                self.blocker(format!("{prefix}_body_invalid:{relative}:{start}"))?;
                continue;
            };
            if bytes.is_empty() || trim(text).is_empty() {
                self.blocker(format!("{prefix}_body_invalid:{relative}:{start}"))?;
                continue;
            }
            if text.len() > 65536 || text.contains('\0') {
                return Err(refused());
            }
            projected_budget(
                self.all().chain(result.iter()).chain([&declaration]),
                40,
                text.len() + relative.len() + digest.len() + 512,
            )?;
            let artifact = match kind {
                Marker::Assertion => Value::Null,
                Marker::Presentation => self.artifact(&declaration)?,
            };
            budget(
                self.all()
                    .chain(result.iter())
                    .chain([&declaration, &artifact]),
            )?;
            let mut value = json!({"declaration":declaration,"manuscriptPath":relative,"manuscriptFileHash":digest,"markerByteStart":start,"markerByteEnd":line.byte_end,"manuscriptByteStart":range.byte_start,"manuscriptByteEnd":range.byte_end,"manuscriptContentHash":bytes_hash(bytes),"text":text});
            if matches!(kind, Marker::Presentation) {
                value["artifact"] = artifact
            }
            budget(self.all().chain(result.iter()).chain([&value]))?;
            result.push(value);
        }
        if let Some((_, start, _)) = open {
            self.blocker(format!("{prefix}_marker_unterminated:{relative}:{start}"))?
        }
        Ok(result)
    }
    pub(super) fn visit(&mut self, relative: &str, depth: usize) -> Result<(), String> {
        self.check()?;
        if self.active.contains(relative) {
            return self.blocker(format!(
                "empirical_assertion_universe_include_cycle:{relative}"
            ));
        }
        if self.visited.contains(relative) {
            return self.blocker(format!(
                "empirical_assertion_universe_include_repeated:{relative}"
            ));
        }
        if self.visited.len() >= self.maximum_files || depth > 32 {
            return self.blocker("empirical_assertion_universe_include_limit_exceeded".into());
        }
        if relative.len() > 4096
            || relative.contains('\\')
            || Path::new(relative)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(refused());
        }
        self.path_bytes = self
            .path_bytes
            .checked_add(relative.len())
            .filter(|v| *v <= 65536)
            .ok_or_else(refused)?;
        self.visited.insert(relative.into());
        self.active.insert(relative.into());
        let Some(metadata) = self.source.inventory_probe(Path::new(relative))? else {
            self.active.remove(relative);
            return self.blocker(format!(
                "empirical_assertion_universe_manuscript_unreadable:{relative}"
            ));
        };
        if metadata.directory {
            self.active.remove(relative);
            return self.blocker(format!(
                "empirical_assertion_universe_manuscript_unreadable:{relative}"
            ));
        }
        if metadata.size > 1024 * 1024 || metadata.link_count != 1 {
            return Err(refused());
        }
        self.context.charge(self.source, Path::new(relative))?;
        let content = self
            .source
            .inventory_document(Path::new(relative), 1024 * 1024)?;
        self.check()?;
        let digest = bytes_hash(&content);
        let file = json!({"path":relative,"hash":digest,"bytes":content.len()});
        budget(self.all().chain([&file]))?;
        self.files.push(file);
        let syntax = analyze_theorem_environment_macro_definitions_with_control_v1(
            &latin1(&content),
            &[],
            self.work,
        )?;
        for blocker in syntax.blockers {
            self.blocker(format!(
                "empirical_assertion_universe_dynamic_tex_unsupported:{relative}:{}",
                blocker.offset
            ))?
        }
        let includes = literal_includes(
            &syntax.masked_source.encode_utf16().collect::<Vec<_>>(),
            relative,
            Universe::EmpiricalAssertion,
            self.context.cancelled(),
            self.context.deadline(),
        )?;
        self.include_bytes =
            includes
                .includes
                .iter()
                .try_fold(self.include_bytes, |total, item| {
                    total
                        .checked_add(item.path.len() + 32)
                        .filter(|v| *v <= 1024 * 1024)
                        .ok_or_else(refused)
                })?;
        for blocker in includes.blockers {
            self.blocker(blocker)?
        }
        let assertions = self.extract(Marker::Assertion, relative, &content, &digest)?;
        budget(self.all().chain(assertions.iter()).chain(assertions.iter()))?;
        self.assertions.extend(assertions.iter().cloned());
        let presentations = self.extract(Marker::Presentation, relative, &content, &digest)?;
        budget(
            self.all()
                .chain(presentations.iter())
                .chain(presentations.iter()),
        )?;
        self.presentations.extend(presentations.iter().cloned());
        let support = extract_formal_support_surfaces_without_authority_v1(
            relative,
            &content,
            self.context.cancelled(),
            self.context.deadline(),
        )?;
        for blocker in support["blockers"].as_array().ok_or_else(refused)? {
            self.blocker(blocker.as_str().ok_or_else(refused)?.into())?
        }
        let supports = support["formalSupports"].as_array().ok_or_else(refused)?;
        budget(self.all().chain(supports.iter()).chain(supports.iter()))?;
        self.supports.extend(supports.iter().cloned());
        let surface = extract_evidence_bound_surfaces_without_ir_v1(
            relative,
            &content,
            self.context.cancelled(),
            self.context.deadline(),
        )?;
        for blocker in surface["blockers"].as_array().ok_or_else(refused)? {
            self.blocker(blocker.as_str().ok_or_else(refused)?.into())?
        }
        let surfaces = surface["surfaces"].as_array().ok_or_else(refused)?;
        budget(self.all().chain(surfaces.iter()).chain(surfaces.iter()))?;
        self.surfaces.extend(surfaces.iter().cloned());
        let units = content.iter().map(|b| u16::from(*b)).collect::<Vec<_>>();
        let patterns = prose_patterns()?;
        for line in line_records(&units, self.context.cancelled(), self.context.deadline())? {
            self.check()?;
            if patterns.legacy.is_match(&line.text) {
                self.blocker(format!(
                    "legacy_empirical_result_marker_forbidden:{relative}:{}",
                    line.byte_start
                ))?
            }
            let raw = strip_comment(&line.text);
            let section = patterns.section.captures(raw);
            let typed = inside(line.byte_start, &assertions)
                || inside(line.byte_start, &presentations)
                || inside(line.byte_start, supports)
                || inside(line.byte_start, surfaces);
            if !typed && patterns.unsupported.is_match(raw) {
                self.blocker(format!(
                    "empirical_assertion_unsupported_result_surface:{relative}:{}",
                    line.byte_start
                ))?
            }
            let selected = includes
                .includes
                .iter()
                .filter(|i| i.byte_start >= line.byte_start && i.byte_start < line.byte_end)
                .collect::<Vec<_>>();
            for included in &selected {
                self.visit(&included.path, depth + 1)?
            }
            if typed
                || self.claim_ranges.iter().any(|claim| {
                    claim["manuscriptPath"] == relative
                        && inside(line.byte_start, std::slice::from_ref(claim))
                })
            {
                continue;
            }
            if let Some(boundary) = patterns.environment.captures(raw) {
                if boundary
                    .get(2)
                    .ok_or_else(refused)?
                    .as_str()
                    .eq_ignore_ascii_case("document")
                    && patterns.standalone.is_match(raw)
                {
                    continue;
                }
                self.blocker(format!(
                    "empirical_assertion_unsupported_environment:{relative}:{}",
                    line.byte_start
                ))?;
                continue;
            }
            let mut remainder = raw.encode_utf16().collect::<Vec<_>>();
            for included in selected.iter().rev() {
                let start = included.byte_start - line.byte_start;
                let end = included.byte_end - line.byte_start;
                if start <= remainder.len() {
                    remainder.drain(start..end.min(remainder.len()));
                }
            }
            let remainder = String::from_utf16(&remainder).map_err(|_| refused())?;
            let remainder = patterns.remove_label.replace_all(&remainder, "");
            let remainder = trim(&remainder);
            if remainder.is_empty() {
                continue;
            }
            if let Some(section) = section {
                if !safe_section(
                    section.get(1).ok_or_else(refused)?.as_str(),
                    &patterns.section_command,
                ) {
                    self.blocker(format!(
                        "empirical_assertion_untrusted_section_surface:{relative}:{}",
                        line.byte_start
                    ))?
                }
                continue;
            }
            if patterns.class.is_match(remainder)
                || patterns.package.is_match(remainder)
                || patterns.theorem.is_match(remainder)
                || patterns.metadata.is_match(remainder)
                || trim(remainder) == "\\title{Autonomous bounded research report}"
                || patterns.standalone.is_match(remainder)
                || patterns.label.is_match(remainder)
                || fixed_prose(remainder)
            {
                continue;
            }
            self.blocker(format!(
                "empirical_assertion_untyped_result_prose:{relative}:{}",
                line.byte_start
            ))?;
        }
        self.active.remove(relative);
        Ok(())
    }
}
