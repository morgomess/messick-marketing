// AIOS review for Morgan's own brands (messickmarketing.com/aios/?k=<AIOS_KEY>).
// Private link, no password (Morgan's call, 2026-10-01). The key is long and lives only in the
// worker secret AIOS_KEY and ~/.secrets/aios-review-key.txt. Approving here publishes publicly.
//   GET  /aios/queue?k=                   Social Posts and Blogs for DSDD + Virtueasy: to review, and approved but not yet pushed
//   POST /aios/update     {k,id,copy?,hashtags?,date?}   edit copy, hashtags, Publish Date (date = "YYYY-MM-DDTHH:mm" Eastern)
//   POST /aios/approve    {k,id}          Social Post: Approved + Ready to Push (refuses past slots). Blog: Approved.
//   POST /aios/retry      {k,id}          Approved + Failed with a future date: back to Ready to Push
//   POST /aios/unapprove  {k,id}          back to Ready for Review / Not Queued, only before Metricool has it
//   POST /aios/reject     {k,id,note?}    Rejected + Not Queued, note into Revision Notes
//   POST /aios/regenerate {k,id,note?}    old record Rejected; brief back to Ready for Generation, note appended to Angle/Hook
//   POST /aios/idea       {k,brand,idea}  new Inbox row (Status New, Related Brand) for the */15 intake

const AIOS = {
  base: 'appLm4Zgt3H2vxKdj', gen: 'tblmuO1jm0DduY1zP', brief: 'tbllmnoa802Vp3Fwu', inbox: 'tblTKxhO77Uqh3BVY',
  brands: { dsdd: { id: 'recadHbQ6SLTiNK2G', name: 'Doggy See, Doggy Do' }, virtueasy: { id: 'recE31wzVXyQkizeH', name: 'Virtueasy' } },
  tz: 'America/New_York',
};
const IN_METRICOOL = new Set(['Queued', 'Scheduled', 'Published']);
const DASH = /[\u2014\u2013]/;

function keyOk(env, k) {
  if (!env.AIOS_KEY || typeof k !== 'string' || k.length !== env.AIOS_KEY.length) return false;
  let d = 0;
  for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ env.AIOS_KEY.charCodeAt(i);
  return d === 0;
}

// Wall-clock time in a zone to UTC ISO.
export function zonedToUtc(local, tz) {
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asZone = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asZone - guess)).toISOString();
}

// The Brand lookup comes back from the REST API as Brand Brain record IDs, not names.
const brandOf = f => { const ids = f.Brand || []; return ids.includes(AIOS.brands.virtueasy.id) ? 'virtueasy' : ids.includes(AIOS.brands.dsdd.id) ? 'dsdd' : null; };
const nameOf = v => (v && typeof v === 'object' ? v.name : v) || '';
const httpError = (msg, status) => Object.assign(new Error(msg), { status });

export async function aios(req, env, url, { json, at, clean }) {
  const p = url.pathname;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const k = req.method === 'GET' ? url.searchParams.get('k') : body.k;
  if (!keyOk(env, k)) return json({ error: 'unauthorized' }, 401);

  const patchGen = (id, fields) => at(env, `${AIOS.base}/${AIOS.gen}`, { method: 'PATCH', body: JSON.stringify({ typecast: true, records: [{ id, fields }] }) });
  const getRecord = async id => {
    if (!/^rec\w{14}$/.test(id || '')) throw httpError('bad id', 400);
    const r = await at(env, `${AIOS.base}/${AIOS.gen}/${id}`);
    if (!brandOf(r.fields)) throw httpError('not a DSDD or Virtueasy record', 403);
    return r;
  };

  try {
    if (p === '/aios/queue' && req.method === 'GET') {
      const formula = "AND(OR({Content Type}='Social Post',{Content Type}='Blog'),"
        + "OR(FIND('Virtueasy',ARRAYJOIN({Brand})),FIND('Doggy',ARRAYJOIN({Brand}))),"
        + "OR({Approval Status}='Ready for Review',{Approval Status}='Revision Requested',"
        + "AND({Approval Status}='Approved',OR({Content Type}='Blog',{Metricool Status}='Ready to Push',{Metricool Status}='Failed'))))";
      const items = [];
      let offset;
      do {
        const q = new URLSearchParams({ filterByFormula: formula, pageSize: '100' });
        if (offset) q.set('offset', offset);
        const page = await at(env, `${AIOS.base}/${AIOS.gen}?${q}`);
        for (const r of page.records) {
          if (!brandOf(r.fields)) continue;
          const f = r.fields, mc = nameOf(f['Metricool Status']) || 'Not Queued';
          items.push({
            id: r.id, name: f.Name || '', brand: brandOf(f),
            type: nameOf(f['Content Type']), copy: f['Generated Copy'] || '', hashtags: f.Hashtags || '',
            channels: (f.Channels || []).map(nameOf), date: f['Publish Date'] || null,
            approval: nameOf(f['Approval Status']), metricool: mc, notes: f['Revision Notes'] || '',
            response: mc === 'Failed' ? String(f['Metricool Response'] || '').slice(0, 300) : '',
            media: (f['Visual Asset'] || []).map(a => ({ url: a.url, type: a.type || '', thumb: a.thumbnails?.large?.url || a.url })),
          });
        }
        offset = page.offset;
      } while (offset);
      items.sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
      return json({ items, now: new Date().toISOString() });
    }

    if (p === '/aios/idea' && req.method === 'POST') {
      const b = AIOS.brands[body.brand], idea = clean(body.idea, 1000);
      if (!b || !idea) return json({ error: 'Pick a brand and type the idea.' }, 400);
      await at(env, `${AIOS.base}/${AIOS.inbox}`, { method: 'POST', body: JSON.stringify({ typecast: true, records: [{ fields: {
        Subject: idea.slice(0, 90), Message: idea, Status: 'New', 'Related Brand': [b.id],
        'Received Date': new Date().toISOString(), From: 'AIOS review page',
      } }] }) });
      return json({ ok: true });
    }

    if (req.method !== 'POST') return json({ error: 'not found' }, 404);
    const r = await getRecord(body.id);
    const f = r.fields, type = nameOf(f['Content Type']), mc = nameOf(f['Metricool Status']);

    if (p === '/aios/update') {
      if (IN_METRICOOL.has(mc)) return json({ error: 'Already in Metricool. Edit it there.' }, 409);
      if (mc === 'Ready to Push') return json({ error: 'Queued for push. Un-approve it first.' }, 409);
      const fields = {};
      if (typeof body.copy === 'string') fields['Generated Copy'] = body.copy.slice(0, 100000);
      if (typeof body.hashtags === 'string') fields.Hashtags = body.hashtags.slice(0, 2000);
      if (typeof body.date === 'string') {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(body.date)) return json({ error: 'bad date' }, 400);
        fields['Publish Date'] = zonedToUtc(body.date, AIOS.tz);
      }
      if (!Object.keys(fields).length) return json({ error: 'nothing to update' }, 400);
      if (DASH.test((fields['Generated Copy'] || '') + (fields.Hashtags || ''))) return json({ error: 'Remove the em or en dash first.' }, 400);
      await patchGen(r.id, fields);
      return json({ ok: true, date: fields['Publish Date'] });
    }

    if (p === '/aios/approve') {
      if (DASH.test(String(f['Generated Copy'] || '') + String(f.Hashtags || ''))) return json({ error: 'The copy has an em or en dash. Edit it first.' }, 400);
      if (type === 'Blog') { await patchGen(r.id, { 'Approval Status': 'Approved' }); return json({ ok: true }); }
      const when = Date.parse(f['Publish Date'] || '');
      if (!when) return json({ error: 'Set a date and time first.' }, 400);
      if (when < Date.now() + 10 * 60e3) return json({ error: 'That time has passed. Pick a new date first.' }, 400);
      await patchGen(r.id, { 'Approval Status': 'Approved', 'Metricool Status': 'Ready to Push' });
      return json({ ok: true });
    }

    // Approved posts that failed in Metricool are never retried by the publish worker (it only polls
    // Ready to Push). Retry re-queues one once its Publish Date is in the future again.
    if (p === '/aios/retry') {
      if (nameOf(f['Approval Status']) !== 'Approved' || mc !== 'Failed') return json({ error: 'Only approved posts that failed can be retried.' }, 409);
      const when = Date.parse(f['Publish Date'] || '');
      if (!when || when < Date.now() + 10 * 60e3) return json({ error: 'That time has passed. Pick a new date first.' }, 400);
      await patchGen(r.id, { 'Metricool Status': 'Ready to Push' });
      return json({ ok: true });
    }
    if (p === '/aios/unapprove') {
      if (IN_METRICOOL.has(mc)) return json({ error: 'Already in Metricool. Remove it there.' }, 409);
      if (nameOf(f['Approval Status']) === 'Published') return json({ error: 'Already published.' }, 409);
      await patchGen(r.id, { 'Approval Status': 'Ready for Review', 'Metricool Status': 'Not Queued' });
      return json({ ok: true });
    }

    if (p === '/aios/reject' || p === '/aios/regenerate') {
      if (IN_METRICOOL.has(mc)) return json({ error: 'Already in Metricool. Remove it there.' }, 409);
      const regen = p === '/aios/regenerate', note = clean(body.note, 1000);
      const fields = { 'Approval Status': 'Rejected', 'Metricool Status': 'Not Queued' };
      if (note || regen) fields['Revision Notes'] = [f['Revision Notes'], (regen ? 'Regenerated' : 'Rejected') + (note ? ': ' + note : '')].filter(Boolean).join('\n');
      if (regen) {
        const briefId = (f.Brief || [])[0];
        if (!briefId) return json({ error: 'No linked brief to regenerate from.' }, 409);
        const brief = await at(env, `${AIOS.base}/${AIOS.brief}/${briefId}`);
        if (!nameOf(brief.fields['Content Type'])) return json({ error: 'The brief has no Content Type. Set it in Airtable first.' }, 409);
        const bf = { Status: 'Ready for Generation' };
        if (note) bf['Angle/Hook'] = `${brief.fields['Angle/Hook'] || ''}\n\nRevision note: ${note}`.trim();
        await at(env, `${AIOS.base}/${AIOS.brief}`, { method: 'PATCH', body: JSON.stringify({ typecast: true, records: [{ id: briefId, fields: bf }] }) });
      }
      await patchGen(r.id, fields);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}
