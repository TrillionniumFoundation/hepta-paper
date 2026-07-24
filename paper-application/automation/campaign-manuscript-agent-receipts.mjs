export function collectCampaignManuscriptAgentExecutionReceipts(
  campaignNodes,
  currentReceipt,
) {
  const receipts = [currentReceipt];
  for (const node of campaignNodes || []) {
    const result = node?.result || node;
    receipts.push(result?.agentExecutionReceipt);
    if (result?.status === 'agent_execution_completed') receipts.push(result);
  }
  return Object.freeze([...new Map(receipts
    .filter((receipt) => receipt?.agentExecutionReceiptHash)
    .map((receipt) => [receipt.agentExecutionReceiptHash, receipt])).values()]);
}
