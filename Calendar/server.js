const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');

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
const EVENTS_FILE = path.join(__dirname, 'data', 'events.json');
const RSVPS_FILE  = path.join(__dirname, 'data', 'rsvps.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'valor2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { return []; }
}
function writeEvents(events) {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}
function readRsvps() {
  try { return JSON.parse(fs.readFileSync(RSVPS_FILE, 'utf8')); } catch { return []; }
}
function writeRsvps(rsvps) {
  fs.mkdirSync(path.dirname(RSVPS_FILE), { recursive: true });
  fs.writeFileSync(RSVPS_FILE, JSON.stringify(rsvps, null, 2));
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

// Admin: upload image
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Public: get all events
app.get('/api/events', (req, res) => res.json(readEvents()));

// Public: get spots remaining for an event
app.get('/api/events/:id/spots', (req, res) => {
  const events = readEvents();
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  if (!event.rsvpCapacity) return res.json({ capacity: null, count: 0, available: null, full: false });
  const count = readRsvps().filter(r => r.eventId === req.params.id).length;
  const available = Math.max(0, event.rsvpCapacity - count);
  res.json({ capacity: event.rsvpCapacity, count, available, full: available === 0 });
});

// Public: RSVP to an event
app.post('/api/rsvp', async (req, res) => {
  const { eventId, studentName, studentAge, parentName, phone, email } = req.body;
  if (!eventId || !studentName || !studentAge || !parentName || !phone || !email) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const events = readEvents();
  const event = events.find(e => e.id === eventId);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const existingRsvps = readRsvps();

  // Prevent duplicate RSVP from same email for same event
  const duplicate = existingRsvps.find(r => r.eventId === eventId && r.email.toLowerCase() === email.toLowerCase());
  if (duplicate) {
    return res.status(400).json({ error: 'This email is already registered for this event.' });
  }

  if (event.rsvpCapacity) {
    const currentCount = existingRsvps.filter(r => r.eventId === eventId).length;
    if (currentCount >= event.rsvpCapacity) {
      return res.status(400).json({ error: 'Sorry, this event is full.' });
    }
  }

  const rsvp = { id: generateId(), eventId, studentName, studentAge, parentName, phone, email, submittedAt: new Date().toISOString() };
  const rsvps = readRsvps();
  rsvps.push(rsvp);
  writeRsvps(rsvps);

  const requirePayment = event.requirePayment !== undefined
    ? event.requirePayment
    : !!event.cost;

  const transporter = createTransporter();

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
app.patch('/api/rsvps/:id', requireAuth, (req, res) => {
  const rsvps = readRsvps();
  const idx = rsvps.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  rsvps[idx] = { ...rsvps[idx], ...req.body };
  writeRsvps(rsvps);
  res.json(rsvps[idx]);
});

// Admin: delete a single RSVP
app.delete('/api/rsvps/:id', requireAuth, (req, res) => {
  const rsvps = readRsvps();
  const filtered = rsvps.filter(r => r.id !== req.params.id);
  if (filtered.length === rsvps.length) return res.status(404).json({ error: 'Not found' });
  writeRsvps(filtered);
  res.json({ ok: true });
});

// Admin: get all RSVPs
app.get('/api/rsvps', requireAuth, (req, res) => {
  res.json(readRsvps());
});

// Admin: get RSVPs for one event
app.get('/api/rsvps/:eventId', requireAuth, (req, res) => {
  const rsvps = readRsvps().filter(r => r.eventId === req.params.eventId);
  res.json(rsvps);
});

function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/events', requireAuth, (req, res) => {
  const events = readEvents();
  const event = { id: generateId(), ...req.body };
  events.push(event);
  writeEvents(events);
  res.json(event);
});

app.put('/api/events/:id', requireAuth, (req, res) => {
  const events = readEvents();
  const idx = events.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  events[idx] = { ...events[idx], ...req.body, id: req.params.id };
  writeEvents(events);
  res.json(events[idx]);
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const events = readEvents();
  const filtered = events.filter(e => e.id !== req.params.id);
  if (filtered.length === events.length) return res.status(404).json({ error: 'Not found' });
  writeEvents(filtered);
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

app.listen(PORT, () => {
  console.log(`Valor Youth Calendar running on port ${PORT}`);
  console.log(`Email sender: ${process.env.EMAIL_USER || '(not set)'}`);
});
