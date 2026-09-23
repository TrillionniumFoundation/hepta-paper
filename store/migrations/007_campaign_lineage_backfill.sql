PRAGMA foreign_keys = ON;

UPDATE paper_campaigns
SET current_review_round=coalesce((
      SELECT max(n.round_index)
      FROM campaign_nodes n
      WHERE n.campaign_id=paper_campaigns.campaign_id
        AND n.status='completed'
        AND n.kind<>'package'
        AND n.round_index>0
    ),0),
    current_round=coalesce((
      SELECT max(n.round_index)
      FROM campaign_nodes n
      WHERE n.campaign_id=paper_campaigns.campaign_id
        AND n.status='completed'
        AND n.kind<>'package'
        AND n.round_index>0
    ),0),
    current_phase=CASE
      WHEN status IN ('completed','failed','stopped','cancelled','paused') THEN status
      ELSE coalesce((
        SELECT n.kind FROM campaign_nodes n
        WHERE n.campaign_id=paper_campaigns.campaign_id
          AND n.status NOT IN ('completed','skipped')
        ORDER BY n.priority,n.created_at,n.node_id LIMIT 1
      ),status)
    END;

UPDATE campaign_nodes
SET role=coalesce(role,json_extract(spec_json,'$.role')),
    reviewer_id=coalesce(reviewer_id,json_extract(result_json,'$.reviewerId')),
    child_session_id=coalesce(child_session_id,json_extract(result_json,'$.childSessionId'),json_extract(result_json,'$.sessionKey')),
    review_hash=coalesce(review_hash,json_extract(result_json,'$.reviewHash')),
    prompt_hash=coalesce(prompt_hash,json_extract(result_json,'$.promptHash')),
    resolved_model=coalesce(resolved_model,json_extract(result_json,'$.resolvedModel'))
WHERE result_json IS NOT NULL AND json_valid(result_json);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','7',datetime('now')),
  ('campaign_lineage_backfill','completed',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
