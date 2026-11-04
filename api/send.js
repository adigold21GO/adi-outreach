import { json, guarded, body, HttpError } from '../lib/http.js';
import { sendToLead } from '../lib/outreach.js';

export const POST = guarded(async (request) => {
  const { leadId, templateId, useDraft, manualConfirm } = await body(request);
  if (!leadId || (!templateId && !useDraft)) throw new HttpError('leadId and templateId are required');
  const r = await sendToLead(leadId, templateId, { source: 'manual', useDraft: !!useDraft, manualConfirm: manualConfirm === true });
  return json({ ok: true, ...r });
});
