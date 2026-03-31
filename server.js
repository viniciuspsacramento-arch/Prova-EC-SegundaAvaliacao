require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const path    = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Banco de dados ──────────────────────────────────────────────────────────
/** Railway: Web service costuma receber referência a MYSQL_URL do plugin; às vezes só MYSQLHOST+MYSQLUSER+… */
function resolveDbUrl() {
  const skip = (s) =>
    !s ||
    s.includes('SENHA') ||
    s.includes('PORTA') ||
    s.startsWith('${{');

  const tryParse = (raw) => {
    const envUrl = String(raw || '').trim();
    if (skip(envUrl)) return null;
    try {
      const u = new URL(envUrl);
      if (u.protocol === 'mysql:' && u.hostname && u.hostname !== 'host') return envUrl;
    } catch (_) {}
    return null;
  };

  for (const key of ['DATABASE_URL', 'MYSQL_URL', 'MYSQL_PUBLIC_URL']) {
    const ok = tryParse(process.env[key]);
    if (ok) return ok;
  }

  const host = (process.env.MYSQLHOST || process.env.MYSQL_HOST || '').trim();
  const user = (process.env.MYSQLUSER || process.env.MYSQL_USER || 'root').trim();
  const pass = String(
    process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD || process.env.MYSQL_PASSWORD || ''
  ).trim();
  const port = String(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306').trim();
  const database = (process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'railway').trim();

  if (host && user) {
    const enc = encodeURIComponent(pass);
    return `mysql://${user}:${enc}@${host}:${port}/${database}`;
  }

  throw new Error(
    'Sem URL MySQL. No Railway: defina DATABASE_URL (referência ao MySQL) ou MYSQL_URL, ou variáveis MYSQLHOST + MYSQLUSER + MYSQLPASSWORD + MYSQLDATABASE. Veja .env.example.'
  );
}

const DB_URL = resolveDbUrl();
let pool;
function db() {
  if (!pool) pool = mysql.createPool(DB_URL);
  return pool;
}

/** Colunas opcionais: painel mostra se o e-mail de resultado foi aceito pelo servidor de envio. */
async function ensureEmailStatusColumns() {
  const pool = db();
  const stmts = [
    'ALTER TABLE tentativas ADD COLUMN resultado_email_enviado_em DATETIME NULL',
    'ALTER TABLE tentativas ADD COLUMN resultado_email_ultimo_erro VARCHAR(512) NULL',
  ];
  for (const sql of stmts) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME' && e.errno !== 1060) throw e;
    }
  }
}

/** Provas “ocultas” só para esta app: linha continua no MySQL, mas não entram no sorteio das 5 turmas. */
async function ensureProvasOcultasTable() {
  await db().query(
    `CREATE TABLE IF NOT EXISTS provas_ocultas_app (
      prova_id INT NOT NULL PRIMARY KEY,
      oculto_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

// ─── Filtro: provas desta aplicação (título no MySQL). Sobrescreva com PROVA_TITULO_LIKE ──
const PROVA_MATCH_RAW = (process.env.PROVA_TITULO_LIKE || 'Estatística Computacional - Segunda Avaliação').trim();
const FILTRO = PROVA_MATCH_RAW.includes('%') ? PROVA_MATCH_RAW : `%${PROVA_MATCH_RAW}%`;
const TITULO_EXIBICAO = (process.env.PROVA_TITULO_EXIBICAO || 'Estatística Computacional — Segunda Avaliação').trim();
const LOGIN_MAX_TENTATIVAS = Number(process.env.ADMIN_LOGIN_MAX_TENTATIVAS || 5);
const LOGIN_BLOQUEIO_MINUTOS = Number(process.env.ADMIN_LOGIN_BLOQUEIO_MINUTOS || 2);
const adminLoginEstadoPorIp = new Map();

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'ip-desconhecido';
}

// Mesma lógica do sistema-provas original:
// 1) ADMIN_PASSWORD
// 2) senha do DB em DATABASE_URL
// 3) fallback admin123
function determineAdminPassword() {
  return process.env.ADMIN_PASSWORD || '433455aA#';
}

function checkPassword(raw) {
  if (!raw) return false;
  return raw.trim() === determineAdminPassword().trim();
}

function requireAdmin(req, res, next) {
  if (!checkPassword(req.headers['x-admin-password'])) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  return next();
}

// ─── Mapeamento matrícula → índice da turma (0=I … 4=V) ─────────────────────
const MAPA_MATRICULA = {
  '0': 0, '1': 0,   // Turma I
  '2': 1, '3': 1,   // Turma II
  '4': 2, '5': 2,   // Turma III
  '6': 3, '7': 3,   // Turma IV
  '8': 4, '9': 4,   // Turma V
};

// ─── Geolocalização: campus UFCA Juazeiro do Norte (ajustável por env) ─────
const CAMPUS_LAT = parseFloat(process.env.CAMPUS_LAT || '-7.21376', 10);
const CAMPUS_LON = parseFloat(process.env.CAMPUS_LON || '-39.31538', 10);
const CAMPUS_RAIO_M = parseFloat(process.env.CAMPUS_RAIO_METROS || '700', 10);
const GEO_MODO = (process.env.GEO_MODO || 'registrar').trim();

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

async function fetchIpGeo(ip) {
  if (!ip || ip === '::1' || ip === 'ip-desconhecido' || ip.startsWith('127.')) return null;
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,lat,lon,query`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.status !== 'success') return null;
    return {
      country: j.country || null,
      regionName: j.regionName || null,
      city: j.city || null,
      lat: typeof j.lat === 'number' ? j.lat : null,
      lon: typeof j.lon === 'number' ? j.lon : null,
    };
  } catch (_) {
    return null;
  }
}

function ipIndicaCearaOuJuazeiro(g) {
  if (!g) return null;
  const est = String(g.regionName || '').toLowerCase();
  const cid = String(g.city || '').toLowerCase();
  if (est.includes('ceará') || est.includes('ceara') || est === 'ce') return 1;
  if (cid.includes('juazeiro')) return 1;
  return 0;
}

async function montarGeoParaSalvar(req, body) {
  const ip = getClientIp(req);
  const ipGeo = await fetchIpGeo(ip);
  let geo_gps_lat = null;
  let geo_gps_lon = null;
  let geo_gps_precisao_m = null;
  let geo_gps_dentro_campus = null;
  const g = body && body.geo_gps;
  if (g && typeof g.lat === 'number' && typeof g.lon === 'number' &&
      !Number.isNaN(g.lat) && !Number.isNaN(g.lon)) {
    geo_gps_lat = g.lat;
    geo_gps_lon = g.lon;
    if (typeof g.accuracy_m === 'number' && !Number.isNaN(g.accuracy_m)) {
      geo_gps_precisao_m = Math.min(65535, Math.round(g.accuracy_m));
    }
    const d = haversineMeters(g.lat, g.lon, CAMPUS_LAT, CAMPUS_LON);
    geo_gps_dentro_campus = d <= CAMPUS_RAIO_M ? 1 : 0;
  }
  return {
    geo_ip_pais: ipGeo?.country ?? null,
    geo_ip_estado: ipGeo?.regionName ?? null,
    geo_ip_cidade: ipGeo?.city ?? null,
    geo_ip_lat: ipGeo?.lat ?? null,
    geo_ip_lon: ipGeo?.lon ?? null,
    geo_ip_ceara: ipIndicaCearaOuJuazeiro(ipGeo),
    geo_gps_lat,
    geo_gps_lon,
    geo_gps_precisao_m,
    geo_gps_dentro_campus,
  };
}

function valoresGeoArray(geo) {
  return [
    geo.geo_ip_pais,
    geo.geo_ip_estado,
    geo.geo_ip_cidade,
    geo.geo_ip_lat,
    geo.geo_ip_lon,
    geo.geo_ip_ceara,
    geo.geo_gps_lat,
    geo.geo_gps_lon,
    geo.geo_gps_precisao_m,
    geo.geo_gps_dentro_campus,
  ];
}

// ─── POST /api/tentativas — iniciar prova via matrícula ──────────────────────
app.post('/api/tentativas', async (req, res) => {
  const { matricula, nome_aluno, email } = req.body;
  if (!matricula || !nome_aluno)
    return res.status(400).json({ error: 'Informe nome e matrícula.' });

  const matriculaStr = matricula.toString().trim().replace(/\D/g, '');
  if (matriculaStr.length < 3)
    return res.status(400).json({ error: 'Matrícula inválida.' });

  const ultimoDigito = matriculaStr.slice(-1);
  const idx = MAPA_MATRICULA[ultimoDigito];
  if (idx === undefined)
    return res.status(400).json({ error: 'Dígito de matrícula não reconhecido.' });

  try {
    const geo = await montarGeoParaSalvar(req, req.body);

    if (GEO_MODO === 'bloquear_gps_fora' && geo.geo_gps_dentro_campus === 0) {
      return res.status(403).json({
        error:
          'Localização fora do perímetro autorizado do campus da UFCA em Juazeiro do Norte. ' +
          'Se você está no campus, permita o acesso à localização no navegador e tente novamente.',
      });
    }

    // Buscar as 5 provas ordenadas (I → V), ignorando as ocultas só nesta aplicação
    const [provas] = await db().query(
      `SELECT id, COALESCE(titulo_publico, titulo) AS titulo, tempo_limite
       FROM provas
       WHERE titulo LIKE ?
         AND id NOT IN (SELECT prova_id FROM provas_ocultas_app)
       ORDER BY titulo`,
      [FILTRO]
    );
    if (provas.length < 5)
      return res.status(500).json({ error: 'Provas não configuradas corretamente.' });

    const prova = provas[idx];
    const ip    = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua    = req.headers['user-agent'] || '';

    const geoSql = `geo_ip_pais, geo_ip_estado, geo_ip_cidade, geo_ip_lat, geo_ip_lon, geo_ip_ceara,
      geo_gps_lat, geo_gps_lon, geo_gps_precisao_m, geo_gps_dentro_campus`;
    const geoPh = '?,?,?,?,?,?,?,?,?,?';
    const gvals = valoresGeoArray(geo);

    let tentativaId;
    try {
      const [r] = await db().query(
        `INSERT INTO tentativas (prova_id, nome_aluno, matricula, email, ip_origem, user_agent, ${geoSql})
         VALUES (?, ?, ?, ?, ?, ?, ${geoPh})`,
        [prova.id, nome_aluno.trim(), matriculaStr, email || null, ip, ua, ...gvals]
      );
      tentativaId = r.insertId;
    } catch (dupErr) {
      if (dupErr.code === 'ER_DUP_ENTRY') {
        const [[exist]] = await db().query(
          'SELECT id, finalizado_em FROM tentativas WHERE matricula = ? LIMIT 1',
          [matriculaStr]
        );
        if (!exist) return res.status(500).json({ error: 'Erro inesperado.' });
        if (exist.finalizado_em) {
          return res.status(409).json({ error: 'Você já realizou esta prova. Entre em contato com o professor caso precise de suporte.' });
        }
        tentativaId = exist.id;
        await db().query(
          `UPDATE tentativas SET
            geo_ip_pais=?, geo_ip_estado=?, geo_ip_cidade=?, geo_ip_lat=?, geo_ip_lon=?, geo_ip_ceara=?,
            geo_gps_lat=?, geo_gps_lon=?, geo_gps_precisao_m=?, geo_gps_dentro_campus=?
           WHERE id=?`,
          [...gvals, tentativaId]
        );
      } else {
        throw dupErr;
      }
    }

    const tituloPublico = TITULO_EXIBICAO;

    let geo_aviso = null;
    if (geo.geo_gps_dentro_campus === 0) {
      geo_aviso = 'GPS indica posição fora do perímetro do campus (registrado). ';
    }
    if (geo.geo_ip_ceara === 0) {
      geo_aviso = (geo_aviso || '') + 'O endereço de rede não indica Ceará/Juazeiro (aproximado).';
    }

    res.json({
      id:           tentativaId,
      prova_id:     prova.id,
      prova_titulo: tituloPublico,
      tempo_limite: prova.tempo_limite || 120,
      geo: {
        gps_dentro_campus: geo.geo_gps_dentro_campus,
        ip_ceara:          geo.geo_ip_ceara,
        cidade_ip:         geo.geo_ip_cidade,
      },
      ...(geo_aviso ? { geo_aviso: geo_aviso.trim() } : {}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/tentativas/:id/questoes ────────────────────────────────────────
app.get('/api/tentativas/:id/questoes', async (req, res) => {
  try {
    const [[tent]] = await db().query(
      'SELECT prova_id, finalizado_em FROM tentativas WHERE id = ?',
      [req.params.id]
    );
    if (!tent) return res.status(404).json({ error: 'Tentativa não encontrada.' });
    if (tent.finalizado_em) return res.status(403).json({ error: 'Prova já finalizada.' });

    const [questoes] = await db().query(
      `SELECT q.id, q.enunciado, pq.ordem, pq.valor_questao
       FROM provas_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem`,
      [tent.prova_id]
    );

    for (const q of questoes) {
      const [alts] = await db().query(
        'SELECT id, texto, ordem FROM alternativas WHERE questao_id = ? ORDER BY ordem',
        [q.id]
      );
      q.alternativas = alts;
    }
    res.json(questoes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/tentativas/:id/responder ──────────────────────────────────────
app.post('/api/tentativas/:id/responder', async (req, res) => {
  const { questao_id, alternativa_id } = req.body;
  if (!questao_id || !alternativa_id) return res.status(400).json({ error: 'Dados incompletos.' });
  try {
    const [[tent]] = await db().query(
      'SELECT id, finalizado_em FROM tentativas WHERE id = ?',
      [req.params.id]
    );
    if (!tent) return res.status(404).json({ error: 'Tentativa não encontrada.' });
    if (tent.finalizado_em) return res.status(403).json({ error: 'Prova já finalizada.' });

    // Upsert manual (sem UNIQUE constraint na tabela)
    await db().query(
      'DELETE FROM respostas WHERE tentativa_id = ? AND questao_id = ?',
      [req.params.id, questao_id]
    );
    await db().query(
      'INSERT INTO respostas (tentativa_id, questao_id, alternativa_id) VALUES (?, ?, ?)',
      [req.params.id, questao_id, alternativa_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/tentativas/:id/troca-aba ──────────────────────────────────────
app.post('/api/tentativas/:id/troca-aba', async (req, res) => {
  try {
    await db().query(
      'UPDATE tentativas SET trocas_aba = trocas_aba + 1 WHERE id = ?',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/tentativas/:id/finalizar ──────────────────────────────────────
app.post('/api/tentativas/:id/finalizar', async (req, res) => {
  const tentId = req.params.id;
  try {
    const [[tent]] = await db().query(
      'SELECT prova_id, finalizado_em FROM tentativas WHERE id = ?',
      [tentId]
    );
    if (!tent) return res.status(404).json({ error: 'Tentativa não encontrada.' });
    if (tent.finalizado_em) return res.status(403).json({ error: 'Prova já finalizada.' });

    // Calcular pontuação com base nas respostas e valor de cada questão
    const [respostas] = await db().query(
      `SELECT al.correta, pq.valor_questao
       FROM respostas r
       JOIN alternativas al ON al.id = r.alternativa_id
       JOIN provas_questoes pq ON pq.prova_id = ? AND pq.questao_id = r.questao_id
       WHERE r.tentativa_id = ?`,
      [tent.prova_id, tentId]
    );

    const [[{ total_pontos }]] = await db().query(
      'SELECT SUM(valor_questao) AS total_pontos FROM provas_questoes WHERE prova_id = ?',
      [tent.prova_id]
    );

    const acertos = respostas.reduce((s, r) => s + (r.correta ? parseFloat(r.valor_questao) : 0), 0);
    const pontuacao = total_pontos > 0 ? (acertos / total_pontos) * 100 : 0;

    await db().query(
      'UPDATE tentativas SET finalizado_em = NOW(), pontuacao = ?, tempo_total = ? WHERE id = ?',
      [pontuacao.toFixed(2), req.body.tempo_total || null, tentId]
    );

    res.json({ pontuacao: pontuacao.toFixed(2) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/tentativas/:id/resultado ───────────────────────────────────────
app.get('/api/tentativas/:id/resultado', async (req, res) => {
  try {
    const [[tent]] = await db().query(
      `SELECT t.id, t.nome_aluno, t.pontuacao, t.trocas_aba, t.tempo_total,
              t.iniciado_em, t.finalizado_em,
              COALESCE(p.titulo_publico, p.titulo) AS prova_titulo_raw
       FROM tentativas t JOIN provas p ON p.id = t.prova_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!tent) return res.status(404).json({ error: 'Tentativa não encontrada.' });

    tent.prova_titulo = TITULO_EXIBICAO;
    delete tent.prova_titulo_raw;

    const [respostas] = await db().query(
      `SELECT pq.ordem,
              q.enunciado,
              a_resp.texto   AS resposta_dada,
              a_resp.correta AS acertou,
              a_cert.texto   AS resposta_correta,
              pq.valor_questao
       FROM respostas r
       JOIN tentativas t ON t.id = r.tentativa_id
       JOIN provas_questoes pq ON pq.prova_id = t.prova_id AND pq.questao_id = r.questao_id
       JOIN questoes q ON q.id = r.questao_id
       JOIN alternativas a_resp ON a_resp.id = r.alternativa_id
       JOIN alternativas a_cert ON a_cert.questao_id = r.questao_id AND a_cert.correta = 1
       WHERE r.tentativa_id = ?
       ORDER BY pq.ordem`,
      [req.params.id]
    );

    res.json({ tentativa: tent, respostas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/debug/db — diagnóstico da conexão do banco ─────────────────────
app.get('/api/debug/db', async (req, res) => {
  try {
    const envRaw = process.env.DATABASE_URL || '(não definida)';
    const envSafe = envRaw.startsWith('mysql://') ? envRaw.replace(/:([^@]+)@/, ':****@') : envRaw.substring(0, 60);
    const [[r]] = await db().query('SELECT 1 AS ok');
    res.json({ db_ok: true, url_usada: DB_URL.replace(/:([^@]+)@/, ':****@'), env_raw: envSafe });
  } catch (e) {
    const envRaw = process.env.DATABASE_URL || '(não definida)';
    const envSafe = envRaw.startsWith('mysql://') ? envRaw.replace(/:([^@]+)@/, ':****@') : envRaw.substring(0, 60);
    res.status(500).json({ db_ok: false, error: e.message, url_usada: DB_URL.replace(/:([^@]+)@/, ':****@'), env_raw: envSafe });
  }
});

// ─── GET /api/auth/info — diagnóstico sem revelar a senha completa ───────────
app.get('/api/auth/info', (req, res) => {
  const adm = determineAdminPassword();
  const fonte = process.env.ADMIN_PASSWORD
    ? 'ADMIN_PASSWORD (env var)'
    : (process.env.DATABASE_URL ? 'DATABASE_URL (senha do banco)' : 'hardcoded');
  res.json({
    ADMIN_PASSWORD_definida: !!process.env.ADMIN_PASSWORD,
    fonte,
    senha_tamanho: adm.length,
    senha_inicio: adm.slice(0, 4),
    senha_fim: adm.slice(-2),
  });
});

// ─── POST /api/auth/login — login admin (mesmo padrão do original) ───────────
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  const adminPassword = determineAdminPassword();
  const ip = getClientIp(req);
  const agora = Date.now();
  const estado = adminLoginEstadoPorIp.get(ip) || { tentativas: 0, bloqueadoAte: 0 };

  if (estado.bloqueadoAte && agora < estado.bloqueadoAte) {
    const minutosRestantes = Math.ceil((estado.bloqueadoAte - agora) / 60000);
    return res.status(429).json({
      success: false,
      error: `Login admin temporariamente bloqueado por tentativas inválidas. Tente novamente em ${minutosRestantes} minuto(s).`
    });
  }

  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (isLocal && password === 'admin') {
    adminLoginEstadoPorIp.delete(ip);
    return res.json({ success: true, token: 'admin-session-active' });
  }

  if ((password || '').trim() === adminPassword.trim()) {
    adminLoginEstadoPorIp.delete(ip);
    return res.json({ success: true, token: 'admin-session-active' });
  }

  estado.tentativas += 1;
  if (estado.tentativas >= LOGIN_MAX_TENTATIVAS) {
    estado.tentativas = 0;
    estado.bloqueadoAte = agora + (LOGIN_BLOQUEIO_MINUTOS * 60000);
    adminLoginEstadoPorIp.set(ip, estado);
    return res.status(429).json({
      success: false,
      error: `Bloqueado após ${LOGIN_MAX_TENTATIVAS} tentativas inválidas. Aguarde ${LOGIN_BLOQUEIO_MINUTOS} minuto(s).`
    });
  }

  adminLoginEstadoPorIp.set(ip, estado);
  const restantes = LOGIN_MAX_TENTATIVAS - estado.tentativas;
  return res.status(401).json({
    success: false,
    error: `Senha incorreta. Restam ${restantes} tentativa(s) antes do bloqueio temporário.`
  });
});

// ─── GET /api/admin/provas — provas que batem com FILTRO (oculta = só nesta app, não apaga MySQL) ──
app.get('/api/admin/provas', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db().query(
      `SELECT p.id, p.titulo, p.titulo_publico, p.tempo_limite, p.criado_em,
              (SELECT COUNT(*) FROM tentativas t WHERE t.prova_id = p.id) AS n_tentativas,
              (SELECT COUNT(*) FROM tentativas t WHERE t.prova_id = p.id AND t.finalizado_em IS NOT NULL) AS n_finalizadas,
              (SELECT COUNT(*) FROM provas_questoes pq WHERE pq.prova_id = p.id) AS n_questoes,
              CASE WHEN o.prova_id IS NOT NULL THEN 1 ELSE 0 END AS oculta
       FROM provas p
       LEFT JOIN provas_ocultas_app o ON o.prova_id = p.id
       WHERE p.titulo LIKE ?
       ORDER BY p.titulo ASC`,
      [FILTRO]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/admin/provas/:id/ocultar — não apaga a prova no banco; só tira desta aplicação ──
app.post('/api/admin/provas/:id/ocultar', requireAdmin, async (req, res) => {
  const provaId = Number(req.params.id);
  if (!Number.isFinite(provaId) || provaId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  try {
    const [[row]] = await db().query('SELECT id FROM provas WHERE id = ? AND titulo LIKE ?', [provaId, FILTRO]);
    if (!row) return res.status(404).json({ error: 'Prova não encontrada ou fora do filtro desta aplicação.' });
    await db().query('INSERT IGNORE INTO provas_ocultas_app (prova_id) VALUES (?)', [provaId]);
    const [[cnt]] = await db().query(
      `SELECT COUNT(*) AS n FROM provas p
       WHERE p.titulo LIKE ? AND p.id NOT IN (SELECT prova_id FROM provas_ocultas_app)`,
      [FILTRO]
    );
    const ativas = Number(cnt.n) || 0;
    const aviso =
      ativas < 5
        ? `Esta aplicação passa a enxergar ${ativas} prova(s) ativa(s). São necessárias 5 para o mapeamento por matrícula (turmas I–V).`
        : null;
    res.json({ ok: true, provas_ativas_no_filtro: ativas, aviso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/admin/provas/:id/restaurar — volta a prova para o conjunto ativo desta app ──
app.post('/api/admin/provas/:id/restaurar', requireAdmin, async (req, res) => {
  const provaId = Number(req.params.id);
  if (!Number.isFinite(provaId) || provaId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  try {
    const [[row]] = await db().query('SELECT id FROM provas WHERE id = ? AND titulo LIKE ?', [provaId, FILTRO]);
    if (!row) return res.status(404).json({ error: 'Prova não encontrada ou fora do filtro desta aplicação.' });
    const [del] = await db().query('DELETE FROM provas_ocultas_app WHERE prova_id = ?', [provaId]);
    const [[cnt]] = await db().query(
      `SELECT COUNT(*) AS n FROM provas p
       WHERE p.titulo LIKE ? AND p.id NOT IN (SELECT prova_id FROM provas_ocultas_app)`,
      [FILTRO]
    );
    const ativas = Number(cnt.n) || 0;
    res.json({
      ok: true,
      provas_ativas_no_filtro: ativas,
      voltou: (del.affectedRows || 0) > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/provas/:id — questões, alternativas e gabarito (só provas do filtro) ──
app.get('/api/admin/provas/:id', requireAdmin, async (req, res) => {
  const provaId = Number(req.params.id);
  if (!Number.isFinite(provaId) || provaId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  try {
    const [[prova]] = await db().query(
      `SELECT p.id, p.titulo, p.titulo_publico, p.descricao, p.tempo_limite, p.criado_em
       FROM provas p WHERE p.id = ? AND p.titulo LIKE ?`,
      [provaId, FILTRO]
    );
    if (!prova) return res.status(404).json({ error: 'Prova não encontrada ou fora do filtro.' });

    const [questoes] = await db().query(
      `SELECT q.id AS questao_id, q.enunciado, pq.ordem, pq.valor_questao
       FROM provas_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem`,
      [provaId]
    );

    for (const q of questoes) {
      const [alts] = await db().query(
        'SELECT id, texto, ordem, correta FROM alternativas WHERE questao_id = ? ORDER BY ordem, id',
        [q.questao_id]
      );
      q.alternativas = alts;
    }

    res.json({ prova, questoes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/tentativas — painel administrativo ───────────────────────
app.get('/api/admin/tentativas', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db().query(
      `SELECT t.id, t.nome_aluno, t.matricula, t.email, t.iniciado_em, t.finalizado_em,
              t.pontuacao, t.tempo_total, t.trocas_aba,
              t.geo_ip_pais, t.geo_ip_estado, t.geo_ip_cidade, t.geo_ip_ceara,
              t.geo_gps_dentro_campus, t.geo_gps_precisao_m,
              t.resultado_email_enviado_em, t.resultado_email_ultimo_erro,
              COALESCE(p.titulo_publico, p.titulo) AS prova_titulo
       FROM tentativas t
       JOIN provas p ON p.id = t.prova_id
       WHERE p.titulo LIKE ?
       ORDER BY t.iniciado_em DESC`,
      [FILTRO]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/tentativas/:id — detalhes da tentativa ───────────────────
app.get('/api/admin/tentativas/:id', requireAdmin, async (req, res) => {
  try {
    const [[tentativa]] = await db().query(
      `SELECT t.id, t.nome_aluno, t.matricula, t.email, t.iniciado_em, t.finalizado_em,
              t.pontuacao, t.tempo_total, t.trocas_aba,
              t.geo_ip_pais, t.geo_ip_estado, t.geo_ip_cidade, t.geo_ip_lat, t.geo_ip_lon, t.geo_ip_ceara,
              t.geo_gps_lat, t.geo_gps_lon, t.geo_gps_precisao_m, t.geo_gps_dentro_campus,
              t.resultado_email_enviado_em, t.resultado_email_ultimo_erro,
              COALESCE(p.titulo_publico, p.titulo) AS prova_titulo
       FROM tentativas t
       JOIN provas p ON p.id = t.prova_id
       WHERE t.id = ? AND p.titulo LIKE ?`,
      [req.params.id, FILTRO]
    );

    if (!tentativa) {
      return res.status(404).json({ error: 'Tentativa não encontrada.' });
    }

    const [respostas] = await db().query(
      `SELECT pq.ordem,
              q.enunciado,
              a_resp.texto AS resposta_dada,
              a_resp.correta AS acertou,
              a_cert.texto AS resposta_correta,
              pq.valor_questao
       FROM respostas r
       JOIN tentativas t ON t.id = r.tentativa_id
       JOIN provas_questoes pq ON pq.prova_id = t.prova_id AND pq.questao_id = r.questao_id
       JOIN questoes q ON q.id = r.questao_id
       JOIN alternativas a_resp ON a_resp.id = r.alternativa_id
       JOIN alternativas a_cert ON a_cert.questao_id = r.questao_id AND a_cert.correta = 1
       WHERE r.tentativa_id = ?
       ORDER BY pq.ordem`,
      [req.params.id]
    );

    res.json({ tentativa, respostas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** Gmail (GMAIL_USER + GMAIL_APP_PASSWORD) tem prioridade sobre Resend (RESEND_API_KEY). */
async function enviarHtmlEmail({ to, subject, html, replyTo }) {
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASS || '').trim();
  const resendKey = (process.env.RESEND_API_KEY || '').trim();

  if (gmailUser && gmailPass) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass.replace(/\s/g, '') },
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 45000,
    });
    const fromName = (process.env.MAIL_FROM_NAME || 'Prova — UFCA').trim();
    await transporter.sendMail({
      from: `"${fromName}" <${gmailUser}>`,
      to,
      replyTo: replyTo || undefined,
      subject,
      html,
    });
    return;
  }

  if (!resendKey) {
    throw httpErr(
      500,
      'Configure envio: GMAIL_USER + GMAIL_APP_PASSWORD (Gmail) ou RESEND_API_KEY (Resend). Veja .env.example.'
    );
  }

  const fromAddr =
    (process.env.RESEND_FROM || '').trim() || 'Prova <onboarding@resend.dev>';
  const emailResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddr,
      to,
      reply_to: replyTo || undefined,
      subject,
      html,
    }),
  });
  const emailResult = await emailResp.json();
  if (!emailResp.ok) {
    throw new Error(emailResult.message || JSON.stringify(emailResult));
  }
}

/** Envia e-mail com resultado; retorna { email }. Lança Error com .status */
async function enviarResultadoEmailPorTentativaId(tentId) {
  const [[tentativa]] = await db().query(
    `SELECT t.id, t.nome_aluno, t.matricula, t.email, t.pontuacao,
            t.iniciado_em, t.finalizado_em, t.prova_id,
            COALESCE(p.titulo_publico, p.titulo) AS prova_titulo
     FROM tentativas t JOIN provas p ON p.id = t.prova_id
     WHERE t.id = ? AND p.titulo LIKE ?`,
    [tentId, FILTRO]
  );
  if (!tentativa) throw httpErr(404, 'Tentativa não encontrada.');
  if (!tentativa.email || !String(tentativa.email).includes('@')) {
    throw httpErr(400, 'Aluno sem e-mail cadastrado.');
  }
  if (!tentativa.finalizado_em) {
    throw httpErr(400, 'Prova ainda não finalizada.');
  }

  const [respostas] = await db().query(
    `SELECT pq.ordem, q.enunciado,
            a_resp.texto AS resposta_dada, a_resp.correta AS acertou,
            a_cert.texto AS resposta_correta, pq.valor_questao
     FROM respostas r
     JOIN tentativas t ON t.id = r.tentativa_id
     JOIN provas_questoes pq ON pq.prova_id = t.prova_id AND pq.questao_id = r.questao_id
     JOIN questoes q ON q.id = r.questao_id
     JOIN alternativas a_resp ON a_resp.id = r.alternativa_id
     JOIN alternativas a_cert ON a_cert.questao_id = r.questao_id AND a_cert.correta = 1
     WHERE r.tentativa_id = ?
     ORDER BY pq.ordem`,
    [tentId]
  );

  const total = respostas.length;
  const corretas = respostas.filter(r => !!r.acertou).length;
  const percentual = total > 0 ? ((corretas / total) * 100).toFixed(1) : '0.0';

  function esc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtBr(v) {
    if (!v) return '-';
    return new Date(v).toLocaleString('pt-BR');
  }

  const rows = respostas.map((r, i) => {
    const cor = r.acertou ? '#166534' : '#991b1b';
    const ico = r.acertou ? '✅ Correta' : '❌ Incorreta';
    return `<tr>
      <td style="padding:8px;border:1px solid #ddd">${i + 1}</td>
      <td style="padding:8px;border:1px solid #ddd">${esc(r.resposta_dada || 'Não respondida')}</td>
      <td style="padding:8px;border:1px solid #ddd">${esc(r.resposta_correta)}</td>
      <td style="padding:8px;border:1px solid #ddd;color:${cor};font-weight:700">${ico}</td>
    </tr>`;
  }).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
    <h2 style="margin:0 0 12px">Resultado — ${esc(TITULO_EXIBICAO)}</h2>
    <p><strong>Aluno:</strong> ${esc(tentativa.nome_aluno)}</p>
    <p><strong>Matrícula:</strong> ${esc(tentativa.matricula)}</p>
    <p><strong>Início:</strong> ${esc(fmtBr(tentativa.iniciado_em))}</p>
    <p><strong>Finalização:</strong> ${esc(fmtBr(tentativa.finalizado_em))}</p>
    <p><strong>Pontuação:</strong> ${esc(tentativa.pontuacao)}%</p>
    <p><strong>Acertos:</strong> ${corretas}/${total} (${percentual}%)</p>
    <hr style="margin:16px 0">
    <h3 style="margin:0 0 8px">Respostas</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:8px;border:1px solid #ddd">#</th>
        <th style="padding:8px;border:1px solid #ddd">Resposta do aluno</th>
        <th style="padding:8px;border:1px solid #ddd">Gabarito</th>
        <th style="padding:8px;border:1px solid #ddd">Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <hr style="margin:16px 0">
    <p style="color:#64748b;font-size:12px">Universidade Federal do Cariri · Prof. Vinicius Sacramento</p>
  </div>`;

  const replyTo = (process.env.MAIL_REPLY_TO || 'vinicius.sacramento@ufca.edu.br').trim();
  const subject = `Resultado — ${TITULO_EXIBICAO} — ${tentativa.nome_aluno}`;

  try {
    await enviarHtmlEmail({
      to: tentativa.email.trim(),
      subject,
      html,
      replyTo,
    });
    await db().query(
      'UPDATE tentativas SET resultado_email_enviado_em = NOW(), resultado_email_ultimo_erro = NULL WHERE id = ?',
      [tentId]
    );
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    try {
      await db().query('UPDATE tentativas SET resultado_email_ultimo_erro = ? WHERE id = ?', [msg, tentId]);
    } catch (_) {}
    throw e;
  }

  return { email: tentativa.email };
}

// ─── POST /api/admin/tentativas/enviar-todos (antes de /:id) ──────────────────
app.post('/api/admin/tentativas/enviar-todos', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db().query(
      `SELECT t.id FROM tentativas t
       JOIN provas p ON p.id = t.prova_id
       WHERE p.titulo LIKE ?
         AND t.finalizado_em IS NOT NULL
         AND TRIM(COALESCE(t.email,'')) <> ''
         AND t.email LIKE '%@%'
       ORDER BY t.id`,
      [FILTRO]
    );
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) {
      return res.json({
        ok: true,
        total: 0,
        enviados: 0,
        falhas: 0,
        message: 'Nenhuma tentativa finalizada com e-mail para enviar.',
      });
    }

    res.json({
      ok: true,
      background: true,
      total: ids.length,
      message:
        `${ids.length} e-mail(ns) na fila no servidor (evita timeout do Railway). ` +
        'Atualize o painel: coluna «Último envio». Logs: [enviar-todos].',
    });

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    setImmediate(() => {
      (async () => {
        for (let i = 0; i < ids.length; i++) {
          try {
            const { email } = await enviarResultadoEmailPorTentativaId(ids[i]);
            console.log(`[enviar-todos] OK #${ids[i]} → ${email}`);
          } catch (err) {
            console.error(`[enviar-todos] FALHA #${ids[i]}:`, err.message);
          }
          if (i < ids.length - 1) await delay(280);
        }
        console.log('[enviar-todos] Fila concluída.');
      })().catch((e) => console.error('[enviar-todos] erro na fila:', e));
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/admin/tentativas/todos (antes de /:id) ───────────────────────
app.delete('/api/admin/tentativas/todos', requireAdmin, async (req, res) => {
  try {
    await db().query(
      `DELETE r FROM respostas r
       INNER JOIN tentativas t ON t.id = r.tentativa_id
       INNER JOIN provas p ON p.id = t.prova_id
       WHERE p.titulo LIKE ?`,
      [FILTRO]
    );
    const [result] = await db().query(
      `DELETE t FROM tentativas t
       INNER JOIN provas p ON p.id = t.prova_id
       WHERE p.titulo LIKE ?`,
      [FILTRO]
    );
    res.json({ ok: true, excluidas: result.affectedRows || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/admin/tentativas/:id — excluir tentativa ─────────────────────
app.delete('/api/admin/tentativas/:id', requireAdmin, async (req, res) => {
  const tentId = req.params.id;
  try {
    const [[row]] = await db().query(
      `SELECT t.id FROM tentativas t
       JOIN provas p ON p.id = t.prova_id
       WHERE t.id = ? AND p.titulo LIKE ?`,
      [tentId, FILTRO]
    );
    if (!row) return res.status(404).json({ error: 'Tentativa não encontrada.' });
    await db().query('DELETE FROM respostas WHERE tentativa_id = ?', [tentId]);
    await db().query('DELETE FROM tentativas WHERE id = ?', [tentId]);
    res.json({ ok: true, message: `Tentativa #${tentId} excluída.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/admin/tentativas/:id/enviar — enviar resultado por e-mail ─────
app.post('/api/admin/tentativas/:id/enviar', requireAdmin, async (req, res) => {
  try {
    const { email } = await enviarResultadoEmailPorTentativaId(req.params.id);
    res.json({ ok: true, message: `E-mail enviado para ${email}` });
  } catch (e) {
    console.error('Erro ao enviar e-mail:', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── Painel /admin ────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Fallback SPA ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
(async () => {
  try {
    await ensureEmailStatusColumns();
    await ensureProvasOcultasTable();
  } catch (e) {
    console.error('[DB] Migração auxiliar:', e.message);
  }
  app.listen(PORT, () => {
    const adm = determineAdminPassword();
    const hint = adm.slice(0, 4) + '*'.repeat(Math.max(0, adm.length - 4));
    console.log(`✓ Estatística Computacional · ${TITULO_EXIBICAO} · porta ${PORT}`);
    console.log(`🔑 Senha admin (hint): ${hint}  |  fonte: ${process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'fallback fixo (.env.example)'}`);
    console.log(`   → Defina ADMIN_PASSWORD no Railway em produção.`);
  });
})();
