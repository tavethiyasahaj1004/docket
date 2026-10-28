/** Customer attachments are immutable to staff — the customer's original
 * evidence must stay in the ticket history even if an agent or admin later
 * tries to remove it. Only non-customer (agent/admin) uploads may be deleted. */
export function canDeleteAttachment(uploadedByRole: string): boolean {
  return uploadedByRole !== "customer";
}
