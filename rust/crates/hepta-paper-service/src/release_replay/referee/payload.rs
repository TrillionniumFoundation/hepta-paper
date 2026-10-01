use super::*;
pub(super) fn metadata(
    family: Family,
    inspected: &[Value],
    candidates: &[Value],
    deterministic: &Value,
) -> Result<Value, String> {
    let r = request(deterministic);
    let ids = |values: &[Value], request_ids: bool| -> Result<Vec<i64>, String> {
        values
            .iter()
            .map(|v| {
                if request_ids {
                    request_id(v)
                } else {
                    patch_id(v)
                }
            })
            .filter(|v| !matches!(v, Ok(0)))
            .collect()
    };
    Ok(match family {
        Family::Request => {
            json!({"deterministic_request_id":request_id(deterministic)?,"deterministic_request_key":field(&r,"request_key"),"deterministic_repair_mode":field(deterministic,"repair_mode"),"deterministic_command":field(deterministic,"next_command_after_repair"),"candidate_count":candidates.len(),"candidate_request_ids":ids(candidates,true)?,"candidate_repair_modes":unique(candidates.iter().map(|v|field(v,"repair_mode")))})
        }
        Family::Resync => {
            json!({"deterministic_request_id":request_id(deterministic)?,"deterministic_request_key":field(&r,"request_key"),"deterministic_patch_id":patch_id(deterministic)?,"deterministic_classification":field(deterministic,"classification"),"deterministic_command":field(deterministic,"next_command"),"candidate_count":candidates.len(),"candidate_keys":candidates.iter().map(|v|Ok(format!("{}:{}:{}:{}",request_id(v)?,patch_id(v)?,js_text(&field(v,"classification")),js_text(&field(&request(v),"request_key"))))).collect::<Result<Vec<_>,String>>()?,"candidate_classifications":unique(candidates.iter().map(|v|field(v,"classification")))})
        }
        Family::Merge => {
            json!({"deterministic_patch_id":patch_id(deterministic)?,"deterministic_slug":field(deterministic,"slug"),"deterministic_batch_id":field(deterministic,"batch_id"),"deterministic_command":command(deterministic)?,"candidate_count":candidates.len(),"inspected_patch_count":inspected.len(),"candidate_patch_ids":ids(candidates,false)?,"inspected_patch_ids":ids(inspected,false)?,"candidate_slugs":unique(candidates.iter().map(|v|field(v,"slug")))})
        }
        Family::Final => {
            json!({"deterministic_route":route_id(deterministic),"deterministic_route_kind":field(deterministic,"route_kind"),"deterministic_command":field(deterministic,"next_command"),"deterministic_slugs":slugs(deterministic),"candidate_count":candidates.len(),"candidate_route_ids":unique(candidates.iter().map(route_id)),"candidate_slugs":unique(candidates.iter().flat_map(|v|slugs(v).into_iter().chain([v["slug"].clone()])))})
        }
    })
}
pub(super) fn plan_empty_fields(family: Family, value: &mut Value) {
    insert(
        value,
        match family {
            Family::Request => {
                json!({"llm_request_id":0,"llm_request_key":"","llm_repair_mode":"","llm_command":""})
            }
            Family::Resync => {
                json!({"llm_request_id":0,"llm_request_key":"","llm_patch_id":0,"llm_classification":"","llm_command":""})
            }
            Family::Merge => {
                json!({"llm_patch_id":0,"llm_slug":"","llm_batch_id":"","llm_command":"","llm_patch_ready":false})
            }
            Family::Final => {
                json!({"llm_route":"","llm_route_kind":"","llm_command":"","llm_slugs":[]})
            }
        },
    )
}
pub(super) fn plan_selected(family: Family, item: &Value, output: &Value) -> Result<Value, String> {
    let r = request(item);
    Ok(match family {
        Family::Request => {
            json!({"llm_request_id":request_id(item)?,"llm_request_key":field(&r,"request_key"),"llm_repair_mode":field(item,"repair_mode"),"llm_command":field(item,"next_command_after_repair")})
        }
        Family::Resync => {
            json!({"llm_request_id":request_id(item)?,"llm_request_key":field(&r,"request_key"),"llm_patch_id":patch_id(item)?,"llm_classification":field(item,"classification"),"llm_command":if js_truthy(&output["allowed_command"]){output["allowed_command"].clone()}else{field(item,"next_command")}})
        }
        Family::Merge => {
            json!({"llm_patch_id":patch_id(item)?,"llm_slug":field(item,"slug"),"llm_batch_id":field(item,"batch_id"),"llm_command":command(item)?,"llm_patch_ready":ready(item)})
        }
        Family::Final => {
            json!({"llm_route":route_id(item),"llm_route_kind":field(item,"route_kind"),"llm_command":field(item,"next_command"),"llm_slugs":slugs(item)})
        }
    })
}
pub(super) fn changed(
    family: Family,
    item: &Value,
    deterministic: &Value,
    selected: &Value,
) -> Result<bool, String> {
    Ok(match family {
        Family::Request => {
            request_id(item)? != request_id(deterministic)?
                || field(item, "repair_mode") != field(deterministic, "repair_mode")
                || field(item, "next_command_after_repair")
                    != field(deterministic, "next_command_after_repair")
        }
        Family::Resync => {
            request_id(item)? != request_id(deterministic)?
                || patch_id(item)? != patch_id(deterministic)?
                || field(item, "classification") != field(deterministic, "classification")
                || selected["llm_command"] != field(deterministic, "next_command")
        }
        Family::Merge => {
            patch_id(item)? != patch_id(deterministic)?
                || field(item, "slug") != field(deterministic, "slug")
                || field(item, "batch_id") != field(deterministic, "batch_id")
                || command(item)? != command(deterministic)?
        }
        Family::Final => {
            route_id(item) != route_id(deterministic)
                || field(item, "next_command") != field(deterministic, "next_command")
                || slugs(item) != slugs(deterministic)
        }
    })
}
pub(super) fn selection_fields(family: Family, item: &Value) -> Result<Value, String> {
    let r = request(item);
    Ok(match family {
        Family::Request => {
            json!({"selected_request_id":request_id(item)?,"selected_request_key":field(&r,"request_key"),"selected_slug":field(&r,"slug"),"selected_repair_mode":field(item,"repair_mode"),"selected_command":field(item,"next_command_after_repair")})
        }
        Family::Resync => {
            json!({"selected_request_id":request_id(item)?,"selected_request_key":field(&r,"request_key"),"selected_slug":field(&r,"slug"),"selected_patch_id":patch_id(item)?,"selected_classification":field(item,"classification"),"selected_command":field(item,"next_command"),"selected_patch_hygiene_command":field(item,"patch_hygiene_command")})
        }
        Family::Merge => {
            json!({"selected_patch_id":patch_id(item)?,"selected_slug":field(item,"slug"),"selected_batch_id":field(item,"batch_id"),"selected_command":command(item)?})
        }
        Family::Final => {
            json!({"selected_route":route_id(item),"selected_route_kind":field(item,"route_kind"),"selected_command":field(item,"next_command"),"selected_slugs":slugs(item)})
        }
    })
}
