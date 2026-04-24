'use strict';

require('dotenv').config();

const fs         = require('fs');
const path       = require('path');
const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT            = Number(process.env.PORT) || 3000;
const CORS_ORIGIN     = process.env.CORS_ORIGIN || '';
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL;
const SMTP_USER       = process.env.SMTP_USER;
// Gmail displays App Passwords with spaces for readability ("abcd efgh ijkl mnop")
// — the actual credential has no whitespace. Strip defensively so either form works.
const SMTP_PASS       = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const UPLOAD_DIR      = path.join(__dirname, 'uploads');
const MAX_UPLOAD      = 100 * 1024 * 1024; // 100 MB

if (!SMTP_USER || !SMTP_PASS) {
  console.warn('[warn] SMTP_USER / SMTP_PASS not set — email send will fail.');
}
if (!RECIPIENT_EMAIL) {
  console.warn('[warn] RECIPIENT_EMAIL not set — email send will fail.');
}
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── App / middleware ────────────────────────────────────────────────────────
const app = express();

const ALLOWED_ORIGINS = [
  'http://localhost:4200',
  'https://your-app-name.netlify.app', // ← replace with your real Netlify URL
  ...CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean),
];

app.use(cors({
  origin:      ALLOWED_ORIGINS,
  methods:     ['GET', 'POST'],
  credentials: true,
}));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} (${req.ip})`);
  next();
});

// ── Multer ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname) || extForMime(file.mimetype);
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `${Date.now()}-${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('video/mp4') || file.mimetype.startsWith('video/webm');
    if (ok) return cb(null, true);
    cb(new Error('Type de fichier non autorisé (video/mp4 ou video/webm requis)'));
  },
});

// ── Nodemailer ──────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: false, // STARTTLS upgrade on 587
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

transporter.verify((err) => {
  if (err) console.warn('[warn] SMTP transporter verify failed:', err.message);
  else      console.log('[info] SMTP transporter ready.');
});

// ── Rate limit: 10 requests / hour / IP ─────────────────────────────────────
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Trop de requêtes. Réessayez dans une heure.',
  },
});

// ── Endpoint ────────────────────────────────────────────────────────────────
app.post(
  '/api/send-interview-email',
  emailLimiter,
  // Run Multer manually so we can translate its errors into our JSON shape.
  (req, res, next) => {
    upload.single('videoFile')(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            message: 'Fichier trop volumineux (max 100MB)',
          });
        }
        return res.status(400).json({ success: false, message: err.message });
      }
      return res.status(400).json({
        success: false,
        message: err.message || 'Fichier invalide',
      });
    });
  },
  async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'Fichier vidéo manquant' });
    }

    const candidateName  = String(req.body.candidateName  || 'Candidat inconnu').slice(0, 120);
    const candidateEmail = req.body.candidateEmail ? String(req.body.candidateEmail).slice(0, 180) : '';
    const interviewRaw   = String(req.body.interviewDate  || new Date().toISOString());
    const questionCount  = String(req.body.questionCount  || '0');
    const videoDuration  = String(req.body.videoDuration  || '0');

    const interviewDate = formatDate(interviewRaw);
    const durationLabel = formatDuration(videoDuration);

    const subject = `Nouvelle vidéo d'entretien - ${candidateName} - ${interviewDate.short}`;
    const html    = buildEmailHtml({
      candidateName,
      candidateEmail,
      interviewDate: interviewDate.long,
      questionCount,
      durationLabel,
    });

    const attachmentName =
      file.mimetype === 'video/mp4' ? 'interview.mp4' : 'interview.webm';

    try {
      const info = await transporter.sendMail({
        from: `"JobSourcing Interview" <${SMTP_USER}>`,
        to:   RECIPIENT_EMAIL,
        subject,
        html,
        attachments: [{ filename: attachmentName, path: file.path }],
      });

      cleanupFile(file.path);
      console.log(`[info] Email sent (messageId=${info.messageId}).`);
      return res.json({ success: true, message: 'Email envoyé avec succès' });

    } catch (err) {
      console.error('[error] Nodemailer sendMail failed:', err);
      cleanupFile(file.path);
      return res.status(502).json({
        success: false,
        message: "Erreur lors de l'envoi de l'email",
      });
    }
  },
);

// ── Health check (useful for Heroku / uptime probes) ────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Catch-all error handler ─────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error] unhandled:', err);
  res.status(500).json({ success: false, message: 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`[jobsourcing-backend] listening on http://localhost:${PORT}`);
  console.log(`[jobsourcing-backend] CORS origin: ${CORS_ORIGIN}`);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanupFile(filePath) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[warn] Failed to delete upload ${filePath}:`, err.message);
    }
  });
}

function extForMime(mime) {
  if (mime === 'video/mp4')  return '.mp4';
  return '.webm';
}

function formatDate(raw) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { short: raw, long: raw };
  }
  const short = d.toLocaleDateString('fr-FR');
  const long  = d.toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  return { short, long };
}

function formatDuration(input) {
  const ms = Number(input);
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function buildEmailHtml({ candidateName, candidateEmail, interviewDate, questionCount, durationLabel }) {
  const rows = [
    ['Nom du candidat', candidateName],
    candidateEmail ? ['Email', candidateEmail] : null,
    ['Date de l’entretien', interviewDate],
    ['Questions répondues',      questionCount],
    ['Durée totale',              durationLabel],
  ].filter(Boolean);

  const tableRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eef2f7;color:#64748b;font-size:13px;width:40%">${escapeHtml(label)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eef2f7;color:#0f172a;font-size:14px;font-weight:600">${escapeHtml(value)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:24px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">Nouvelle vidéo d'entretien</h1>
        <p style="margin:6px 0 0;color:#dbeafe;font-size:13px">Un candidat vient de terminer son entretien vidéo.</p>
      </div>
      <div style="padding:20px 24px">
        <table style="width:100%;border-collapse:collapse">
          ${tableRows}
        </table>
        <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6">
          La vidéo compilée est jointe à cet email.<br>
          Cet envoi a été généré automatiquement par JobSourcing&nbsp;Interview.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
