const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const cron = require('node-cron');
const Database = require('@replit/database');

const db = new Database();

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 8 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'valor2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function readEvents() {
  return (await db.get('events')) || [];
}
async function writeEvents(events) {
  await db.set('events', events);
}
async function readRsvps() {
  return (await db.get('rsvps')) || [];
}
async function writeRsvps(rsvps) {
  await db.set('rsvps', rsvps);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Admin: upload image
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Public: get all events (past events filtered out)
app.get('/api/events', async (req, res) => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const events = (await readEvents()).filter(e => (e.endDate || e.date) >= today);
  res.json(events);
});

// Public: get spots remaining for an event
app.get('/api/events/:id/spots', async (req, res) => {
  const events = await readEvents();
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  if (!event.rsvpCapacity) return res.json({ capacity: null, count: 0, available: null, full: false });
  const count = (await readRsvps()).filter(r => r.eventId === req.params.id).length;
  const available = Math.max(0, event.rsvpCapacity - count);
  res.json({ capacity: event.rsvpCapacity, count, available, full: available === 0 });
});

// Public: RSVP to an event
app.post('/api/rsvp', async (req, res) => {
  const { eventId, studentName, studentAge, parentName, phone, email, notes } = req.body;
  if (!eventId || !studentName || !studentAge || !parentName || !phone || !email) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const events = await readEvents();
  const event = events.find(e => e.id === eventId);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const existingRsvps = await readRsvps();

  const duplicate = existingRsvps.find(r =>
    r.eventId === eventId &&
    r.email.toLowerCase() === email.toLowerCase() &&
    r.studentName.toLowerCase() === studentName.toLowerCase()
  );
  if (duplicate) {
    return res.status(400).json({ error: 'This student is already registered for this event.' });
  }

  if (event.rsvpCapacity) {
    const currentCount = existingRsvps.filter(r => r.eventId === eventId).length;
    if (currentCount >= event.rsvpCapacity) {
      return res.status(400).json({ error: 'Sorry, this event is full.' });
    }
  }

  const rsvp = { id: generateId(), eventId, studentName, studentAge, parentName, phone, email, notes: notes || '', submittedAt: new Date().toISOString() };
  const rsvps = await readRsvps();
  rsvps.push(rsvp);
  await writeRsvps(rsvps);

  const requirePayment = event.requirePayment !== undefined ? event.requirePayment : !!event.cost;

  const staffMail = {
    from: `"Valor Youth Calendar" <${process.env.EMAIL_USER}>`,
    to: 'youth@valor.church',
    subject: `RSVP: ${studentName} for ${event.title}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#000;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:1.1rem;">New RSVP — Valor Youth</h2>
        </div>
        <div style="background:#f9f9f9;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <h3 style="color:#4D3033;margin:0 0 16px;">${event.title}</h3>
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
            <tr><td style="padding:6px 0;color:#555;width:140px;">Date</td><td style="padding:6px 0;font-weight:600;">${event.date}${event.endDate ? ' – ' + event.endDate : ''}</td></tr>
            ${event.time ? `<tr><td style="padding:6px 0;color:#555;">Time</td><td style="padding:6px 0;font-weight:600;">${event.time}</td></tr>` : ''}
            ${event.cost ? `<tr><td style="padding:6px 0;color:#555;">Cost</td><td style="padding:6px 0;font-weight:600;">${event.cost}</td></tr>` : ''}
            <tr><td colspan="2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;"></td></tr>
            <tr><td style="padding:6px 0;color:#555;">Student Name</td><td style="padding:6px 0;font-weight:600;">${studentName}</td></tr>
            <tr><td style="padding:6px 0;color:#555;">Student Age</td><td style="padding:6px 0;font-weight:600;">${studentAge}</td></tr>
            <tr><td style="padding:6px 0;color:#555;">Parent Name</td><td style="padding:6px 0;font-weight:600;">${parentName}</td></tr>
            <tr><td style="padding:6px 0;color:#555;">Phone</td><td style="padding:6px 0;font-weight:600;">${phone}</td></tr>
            <tr><td style="padding:6px 0;color:#555;">Email</td><td style="padding:6px 0;font-weight:600;"><a href="mailto:${email}">${email}</a></td></tr>
            ${notes ? `<tr><td colspan="2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;"></td></tr><tr><td style="padding:6px 0;color:#555;vertical-align:top;">Notes</td><td style="padding:6px 0;font-weight:600;color:#b91c1c;">${notes}</td></tr>` : ''}
          </table>
        </div>
      </div>`
  };

  const parentMail = {
    from: `"Valor Youth" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `You're registered: ${event.title}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#000;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:1.1rem;">Registration Confirmed — Valor Youth</h2>
        </div>
        <div style="background:#f9f9f9;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <p style="margin:0 0 12px;">Hi ${parentName},</p>
          <p style="margin:0 0 16px;">We've received your registration for <strong>${studentName}</strong>. Here's a summary:</p>
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
            <tr><td style="padding:6px 0;color:#555;width:140px;">Event</td><td style="padding:6px 0;font-weight:600;">${event.title}</td></tr>
            <tr><td style="padding:6px 0;color:#555;">Date</td><td style="padding:6px 0;font-weight:600;">${event.date}${event.endDate ? ' – ' + event.endDate : ''}</td></tr>
            ${event.time ? `<tr><td style="padding:6px 0;color:#555;">Time</td><td style="padding:6px 0;font-weight:600;">${event.time}</td></tr>` : ''}
            ${event.location ? `<tr><td style="padding:6px 0;color:#555;">Location</td><td style="padding:6px 0;font-weight:600;">${event.location}</td></tr>` : ''}
            ${event.cost ? `<tr><td style="padding:6px 0;color:#555;">Cost</td><td style="padding:6px 0;font-weight:600;">${event.cost}</td></tr>` : ''}
          </table>
          ${requirePayment ? `
          <div style="margin-top:20px;padding:14px;background:#fff8f0;border:1px solid #fed7aa;border-radius:6px;">
            <p style="margin:0;font-size:0.88rem;color:#7c2d12;">
              <strong>Payment reminder:</strong> Please complete your payment at
              <a href="https://valor.churchcenter.com/giving/to/tlc-youth" style="color:#4D3033;">Church Center</a>.
            </p>
          </div>` : ''}
          <p style="margin-top:20px;font-size:0.85rem;color:#6b7280;">Questions? Contact us at <a href="mailto:youth@valor.church" style="color:#4D3033;">youth@valor.church</a>.</p>
          <p style="margin-top:8px;font-size:0.8rem;color:#9ca3af;">Need to cancel? <a href="https://valoryouth.replit.app/cancel/${rsvp.id}" style="color:#9ca3af;">Click here to remove this registration.</a></p>
        </div>
      </div>`
  };

  // Respond immediately — RSVP is saved. Email is best-effort.
  res.json({ ok: true });

  try {
    const transporter = createTransporter();
    await transporter.sendMail(staffMail);
    await transporter.sendMail(parentMail);
  } catch (err) {
    console.error('Email error (RSVP still saved):', err.message);
  }
});

// Admin: update a single RSVP (e.g. mark paid)
app.patch('/api/rsvps/:id', requireAuth, async (req, res) => {
  const rsvps = await readRsvps();
  const idx = rsvps.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  rsvps[idx] = { ...rsvps[idx], ...req.body };
  await writeRsvps(rsvps);
  res.json(rsvps[idx]);
});

// Admin: delete a single RSVP
app.delete('/api/rsvps/:id', requireAuth, async (req, res) => {
  const rsvps = await readRsvps();
  const filtered = rsvps.filter(r => r.id !== req.params.id);
  if (filtered.length === rsvps.length) return res.status(404).json({ error: 'Not found' });
  await writeRsvps(filtered);
  res.json({ ok: true });
});

// Admin: get all RSVPs
app.get('/api/rsvps', requireAuth, async (req, res) => {
  res.json(await readRsvps());
});

// Admin: export ALL data for reference / manual backup
app.get('/api/admin/export', requireAuth, async (req, res) => {
  res.json({ events: await readEvents(), rsvps: await readRsvps() });
});

// Admin: get RSVPs for one event
app.get('/api/rsvps/:eventId', requireAuth, async (req, res) => {
  const rsvps = (await readRsvps()).filter(r => r.eventId === req.params.eventId);
  res.json(rsvps);
});

app.post('/api/events', requireAuth, async (req, res) => {
  const events = await readEvents();
  const event = { id: generateId(), ...req.body };
  events.push(event);
  await writeEvents(events);
  res.json(event);
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  const events = await readEvents();
  const idx = events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  events[idx] = { ...events[idx], ...req.body, id: req.params.id };
  await writeEvents(events);
  res.json(events[idx]);
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const events = await readEvents();
  const filtered = events.filter(e => e.id !== req.params.id);
  if (filtered.length === events.length) return res.status(404).json({ error: 'Not found' });
  await writeEvents(filtered);
  res.json({ ok: true });
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// Public: parent self-cancellation via link in confirmation email
app.get('/cancel/:rsvpId', async (req, res) => {
  const rsvps = await readRsvps();
  const rsvp = rsvps.find(r => r.id === req.params.rsvpId);

  const page = (title, body) => `<!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — Valor Youth</title>
    <style>body{font-family:sans-serif;background:#faf9f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .card{background:#fff;border:1px solid #e5e2dc;border-radius:10px;padding:36px 32px;max-width:420px;width:90%;text-align:center;}
    h2{margin:0 0 12px;color:#000;}p{color:#555;margin:0 0 20px;line-height:1.5;}
    a{color:#4D3033;font-size:0.85rem;}</style></head>
    <body><div class="card"><h2>${title}</h2>${body}</div></body></html>`;

  if (!rsvp) {
    return res.send(page('Already Cancelled', '<p>This registration was not found — it may have already been cancelled.</p><p><a href="https://valoryouth.replit.app">Back to calendar</a></p>'));
  }

  const events = await readEvents();
  const event = events.find(e => e.id === rsvp.eventId);
  await writeRsvps(rsvps.filter(r => r.id !== req.params.rsvpId));

  const eventName = event ? event.title : 'the event';
  res.send(page('Registration Cancelled', `<p><strong>${rsvp.studentName}</strong> has been removed from <strong>${eventName}</strong>.</p><p>Questions? Email <a href="mailto:youth@valor.church">youth@valor.church</a>.</p><p><a href="https://valoryouth.replit.app">Back to calendar</a></p>`));

  try {
    await createTransporter().sendMail({
      from: `"Valor Youth" <${process.env.EMAIL_USER}>`,
      to: 'youth@valor.church',
      subject: `Cancellation: ${rsvp.studentName} — ${eventName}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#000;padding:16px 20px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;font-size:1.1rem;">RSVP Cancelled — Valor Youth</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 12px;"><strong>${rsvp.parentName}</strong> cancelled the registration for <strong>${rsvp.studentName}</strong> from <strong>${eventName}</strong>${event ? ' on ' + event.date : ''}.</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
              <tr><td style="padding:5px 0;color:#555;width:120px;">Student</td><td style="padding:5px 0;">${rsvp.studentName}, age ${rsvp.studentAge}</td></tr>
              <tr><td style="padding:5px 0;color:#555;">Parent</td><td style="padding:5px 0;">${rsvp.parentName}</td></tr>
              <tr><td style="padding:5px 0;color:#555;">Phone</td><td style="padding:5px 0;">${rsvp.phone}</td></tr>
              <tr><td style="padding:5px 0;color:#555;">Email</td><td style="padding:5px 0;">${rsvp.email}</td></tr>
            </table>
          </div>
        </div>`
    });
  } catch (err) {
    console.error('Cancellation notification failed:', err.message);
  }
});

// Daily noon MT: email RSVP roster for tomorrow's RSVP-enabled events
cron.schedule('0 12 * * *', async () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const events = (await readEvents()).filter(e => e.rsvpEnabled && e.date === tomorrowStr);
  if (!events.length) return;

  const allRsvps = await readRsvps();

  for (const event of events) {
    const rsvps = allRsvps.filter(r => r.eventId === event.id);
    if (!rsvps.length) continue;

    const rows = rsvps.map((r, i) => `
      <tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'};">
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${i + 1}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;">${r.studentName}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${r.studentAge}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${r.parentName}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${r.phone}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${r.email}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:${r.paid ? '#065f46' : '#9ca3af'};">${r.paid ? '✓ Paid' : 'Unpaid'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:${r.notes ? '#b91c1c' : '#9ca3af'};">${r.notes || '—'}</td>
      </tr>`).join('');

    const mail = {
      from: `"Valor Youth" <${process.env.EMAIL_USER}>`,
      to: 'youth@valor.church',
      subject: `Tomorrow's RSVP List — ${event.title} (${rsvps.length} registered)`,
      html: `
        <div style="font-family:sans-serif;max-width:680px;margin:0 auto;">
          <div style="background:#000;padding:16px 20px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;font-size:1.1rem;">Tomorrow's RSVP List — Valor Youth</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            <h3 style="color:#4D3033;margin:0 0 4px;">${event.title}</h3>
            <p style="margin:0 0 16px;color:#555;font-size:0.9rem;">${event.date}${event.time ? ' &middot; ' + event.time : ''}${event.location ? ' &middot; ' + event.location : ''} &middot; ${rsvps.length} registered</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
              <thead>
                <tr style="background:#000;color:#fff;">
                  <th style="padding:8px 10px;text-align:left;">#</th>
                  <th style="padding:8px 10px;text-align:left;">Student</th>
                  <th style="padding:8px 10px;text-align:left;">Age</th>
                  <th style="padding:8px 10px;text-align:left;">Parent</th>
                  <th style="padding:8px 10px;text-align:left;">Phone</th>
                  <th style="padding:8px 10px;text-align:left;">Email</th>
                  <th style="padding:8px 10px;text-align:left;">Paid</th>
                  <th style="padding:8px 10px;text-align:left;">Notes</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`
    };

    try {
      await createTransporter().sendMail(mail);
      console.log(`Roster email sent for "${event.title}" (${rsvps.length} registrants)`);
    } catch (err) {
      console.error(`Roster email failed for "${event.title}":`, err.message);
    }
  }
}, { timezone: 'America/Denver' });

// Monday 8am MT: weekly summary of upcoming events
cron.schedule('0 8 * * 1', async () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const next7 = new Date(now);
  next7.setDate(next7.getDate() + 7);
  const next7Str = `${next7.getFullYear()}-${String(next7.getMonth() + 1).padStart(2, '0')}-${String(next7.getDate()).padStart(2, '0')}`;

  const allEvents = (await readEvents()).filter(e => e.date >= todayStr && e.date <= next7Str);
  if (!allEvents.length) return;

  const allRsvps = await readRsvps();
  const rows = allEvents.map(e => {
    const count = allRsvps.filter(r => r.eventId === e.id).length;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${e.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${e.date}${e.time ? ' &middot; ' + e.time : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${e.rsvpEnabled ? count : '—'}</td>
    </tr>`;
  }).join('');

  const mail = {
    from: `"Valor Youth" <${process.env.EMAIL_USER}>`,
    to: 'youth@valor.church',
    subject: `This Week's Youth Events — ${todayStr}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#000;padding:16px 20px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:1.1rem;">This Week — Valor Youth</h2>
        </div>
        <div style="background:#f9f9f9;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
            <thead><tr style="background:#000;color:#fff;">
              <th style="padding:8px 12px;text-align:left;">Event</th>
              <th style="padding:8px 12px;text-align:left;">Date / Time</th>
              <th style="padding:8px 12px;text-align:center;">RSVPs</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:16px;font-size:0.85rem;color:#6b7280;">
            <a href="https://valoryouth.replit.app/admin.html" style="color:#4D3033;">Open admin panel</a>
          </p>
        </div>
      </div>`
  };

  try {
    await createTransporter().sendMail(mail);
    console.log(`Weekly summary sent (${allEvents.length} events)`);
  } catch (err) {
    console.error('Weekly summary email failed:', err.message);
  }
}, { timezone: 'America/Denver' });

// 1st of each month at 3am MT: purge events and RSVPs older than 90 days
cron.schedule('0 3 1 * *', async () => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;

  const events = await readEvents();
  const staleIds = new Set(events.filter(e => (e.endDate || e.date) < cutoffStr).map(e => e.id));
  if (!staleIds.size) return;

  await writeEvents(events.filter(e => !staleIds.has(e.id)));
  await writeRsvps((await readRsvps()).filter(r => !staleIds.has(r.eventId)));
  console.log(`Purged ${staleIds.size} events older than 90 days`);
}, { timezone: 'America/Denver' });

// On startup: migrate data from JSON files if Replit DB is empty
async function start() {
  const existing = await db.get('events');
  if (existing === null || existing === undefined) {
    try {
      const eventsFile = path.join(__dirname, 'data', 'events.json');
      const rsvpsFile  = path.join(__dirname, 'data', 'rsvps.json');
      const events = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile, 'utf8')) : [];
      const rsvps  = fs.existsSync(rsvpsFile)  ? JSON.parse(fs.readFileSync(rsvpsFile,  'utf8')) : [];
      await db.set('events', events);
      await db.set('rsvps', rsvps);
      console.log(`Migrated ${events.length} events and ${rsvps.length} RSVPs from files to Replit DB`);
    } catch (err) {
      await db.set('events', []);
      await db.set('rsvps', []);
      console.log('Initialized empty Replit DB');
    }
  }

  app.listen(PORT, () => {
    console.log(`Valor Youth Calendar running on port ${PORT}`);
    console.log(`Email sender: ${process.env.EMAIL_USER || '(not set)'}`);
  });
}

start();
