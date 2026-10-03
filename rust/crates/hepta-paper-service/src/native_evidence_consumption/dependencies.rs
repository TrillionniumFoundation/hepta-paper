use super::*;
struct Graph<'a, 'b> {
    nodes: Vec<(String, &'a Value)>,
    visiting: Vec<String>,
    visited: Vec<String>,
    blockers: Vec<String>,
    edges: usize,
    work: &'b mut Work<'a>,
}
impl Graph<'_, '_> {
    fn visit(&mut self, id: &str, trail: &[String]) -> Result<(), String> {
        self.work.check()?;
        if self.visiting.iter().any(|v| v == id) {
            return self.work.cycle_blocker(&mut self.blockers, trail, id);
        }
        if self.visited.iter().any(|v| v == id) {
            return Ok(());
        }
        let node = self
            .nodes
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, node)| *node)
            .ok_or_else(refused)?;
        if trail.len() >= 128 {
            return Err(refused());
        }
        self.work.reserve(2, id.len() * 2)?;
        self.visiting.push(id.into());
        let edges = if truthy(&node["dependsOn"]) {
            node["dependsOn"].as_array().ok_or_else(refused)?.as_slice()
        } else {
            &[]
        };
        let hashes = &node["dependencyOutputHashes"];
        if truthy(hashes) && !hashes.is_object() {
            return Err(refused());
        }
        for edge in edges {
            self.edges += 1;
            if self.edges > 1024 {
                return Err(refused());
            }
            let key = self.work.string(edge)?;
            if let Some(dependency) = self
                .nodes
                .iter()
                .find(|(id, _)| id == &key)
                .map(|(_, node)| *node)
            {
                self.work.reserve(
                    trail.len() + 1,
                    trail.iter().map(|v| v.len()).sum::<usize>() + id.len(),
                )?;
                let mut next = trail.to_vec();
                next.push(id.into());
                self.visit(&key, &next)?;
                let bound = &hashes[&key];
                if !truthy(bound) || !strict(bound, &dependency["outputHash"]) {
                    self.work.blocker_parts(
                        &mut self.blockers,
                        &["evidence_dependency_hash_stale:", id, ":", &key],
                    )?;
                }
            } else {
                self.work.blocker_parts(
                    &mut self.blockers,
                    &["evidence_dependency_missing:", id, ":", &key],
                )?;
            }
        }
        if !truthy(&node["outputHash"]) {
            self.work.blocker_parts(
                &mut self.blockers,
                &["evidence_dependency_output_hash_missing:", id],
            )?;
        }
        self.visiting.retain(|v| v != id);
        self.visited.push(id.into());
        Ok(())
    }
}
pub(super) fn freshness<'a>(input: &'a [Value], work: &mut Work<'a>) -> Result<Value, String> {
    if input.len() > 128 {
        return Err(refused());
    }
    let mut nodes: Vec<(String, &Value)> = Vec::new();
    for node in input {
        work.check()?;
        if !node.is_object() {
            return Err(refused());
        }
        let id = match node.get("id") {
            Some(id) => work.string(id)?,
            None => "undefined".into(),
        };
        if let Some((_, held)) = nodes.iter_mut().find(|(key, _)| key == &id) {
            *held = node;
        } else {
            nodes.push((id, node));
        }
    }
    work.reserve(nodes.len(), nodes.iter().map(|(id, _)| id.len()).sum())?;
    let keys = nodes.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let count = nodes.len();
    let mut graph = Graph {
        nodes,
        visiting: Vec::new(),
        visited: Vec::new(),
        blockers: Vec::new(),
        edges: 0,
        work,
    };
    for key in keys {
        graph.visit(&key, &[])?;
    }
    graph.work.reserve(8, 256)?;
    let blockers = unique(graph.blockers, graph.work)?;
    hashed(
        "EvidenceDependencyFreshnessReport",
        json!({"version":1,"kind":"EvidenceDependencyFreshnessReport","status":if blockers.is_empty(){"evidence_dependency_chain_fresh"}else{"evidence_dependency_chain_stale"},"nodeCount":count,"blockers":blockers}),
        graph.work,
        "evidenceDependencyFreshnessHash",
    )
}
