export function campaignUsageSql(delta = {}) {
  const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd')
    && Number.isFinite(Number(delta.costUsd));
  const agent = Math.max(0, Number(delta.agentCalls || 0));
  const cpu = Math.max(0, Number(delta.cpuJobs || 0));
  const gpu = Math.max(0, Number(delta.gpuJobs || 0));
  const tokens = Math.max(0, Number(delta.tokens || 0));
  const cost = costProvided ? Math.max(0, Number(delta.costUsd)) : 0;
  const pricedCalls = costProvided
    ? Math.max(0, Number(delta.pricedAgentCalls ?? 1)) : 0;
  return `agent_call_count=agent_call_count+${agent},cpu_job_count=cpu_job_count+${cpu},gpu_job_count=gpu_job_count+${gpu},token_count=token_count+${tokens},cost_usd=cost_usd+${cost},priced_agent_call_count=priced_agent_call_count+${pricedCalls},cost_known=CASE WHEN agent_call_count+${agent}=priced_agent_call_count+${pricedCalls} THEN 1 ELSE 0 END`;
}

export function campaignUsageBudgetCondition(delta = {}) {
  const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd')
    && Number.isFinite(Number(delta.costUsd));
  const agent = Math.max(0, Number(delta.agentCalls || 0));
  const cpu = Math.max(0, Number(delta.cpuJobs || 0));
  const gpu = Math.max(0, Number(delta.gpuJobs || 0));
  const tokens = Math.max(0, Number(delta.tokens || 0));
  const cost = costProvided ? Math.max(0, Number(delta.costUsd)) : 0;
  return [
    `agent_call_count+${agent}<=coalesce(json_extract(spec_json,'$.budgets.maxAgentCalls'),9e15)`,
    `cpu_job_count+${cpu}<=coalesce(json_extract(spec_json,'$.budgets.maxCpuJobs'),9e15)`,
    `gpu_job_count+${gpu}<=coalesce(json_extract(spec_json,'$.budgets.maxGpuJobs'),9e15)`,
    `token_count+${tokens}<=coalesce(json_extract(spec_json,'$.budgets.maxTokenCount'),9e15)`,
    ...(costProvided
      ? [`cost_usd+${cost}<=coalesce(json_extract(spec_json,'$.budgets.maxCostUsd'),9e15)`]
      : []),
  ].join(' AND ');
}
