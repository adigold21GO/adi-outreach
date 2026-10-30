import { json, guarded, body, HttpError } from '../lib/http.js';
import { sendToLead } from '../lib/outreach.js';

export const POST = guarded(async (request) => {
  const { leadId, templateId } = await body(request);
  if (!leadId || !templateId) throw new HttpError('leadId and templateId are required');
  const r = await sendToLead(leadId, templateId, { source: 'manual' });
  return json({ ok: true, ...r });
});
