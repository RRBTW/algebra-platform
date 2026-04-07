const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const { seed } = require('./seed');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || '0000';

// ─── Logging ──────────────────────────────────────────────────────────────────

const logs = [];

function log(level, event, data = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,   // 'INFO' | 'WARN' | 'ERROR' | 'ANSWER'
    event,
    ...data,
  };
  logs.push(entry);
  if (logs.length > 1000) logs.shift(); // держим последние 1000

  const tag = { INFO: '📘', WARN: '⚠️', ERROR: '❌', ANSWER: '📝' }[level] || '•';
  const dataStr = Object.keys(data).length
    ? ' ' + JSON.stringify(data)
    : '';
  console.log(`${tag} [${entry.time.slice(11,19)}] ${event}${dataStr}`);
}

// ─── Startup ─────────────────────────────────────────────────────────────────

db.getDb();
if (db.countQuestions() === 0) {
  log('INFO', 'seed:start');
  seed();
  log('INFO', 'seed:done', { questions: db.countQuestions() });
} else {
  log('INFO', 'seed:skip', { questions: db.countQuestions() });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Логируем все API-запросы
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 400 ? 'WARN' : 'INFO';
    log(level, `${req.method} ${req.path}`, { status: res.statusCode, ms });
  });
  next();
});

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-pass'] || req.query.pass;
  if (pass === ADMIN_PASS) return next();
  log('WARN', 'admin:auth-fail', { ip: req.ip });
  res.status(401).json({ error: 'Неверный пароль администратора' });
}

// ─── Student API ──────────────────────────────────────────────────────────────

app.post('/api/student/login', (req, res) => {
  const { name, token: existingToken } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя' });

  const token = existingToken || uuidv4();
  const student = db.findOrCreateStudent(name.trim(), token);
  log('INFO', 'student:login', { name: student.name, id: student.id });
  res.json({ token: student.session_token, studentId: student.id, name: student.name });
});

app.get('/api/tests', (req, res) => {
  const tests = db.getActiveTests();
  const token = req.query.token;
  let student = null;
  if (token) student = db.getStudentByToken(token);

  const result = tests.map(t => {
    const questionCount = db.getQuestionsByTest(t.id).length;
    let status = 'not_started', score = null, total = null, attemptId = null;
    if (student) {
      const attempt = db.getActiveAttempt(student.id, t.id);
      const attempts = db.getStudentAttempts(student.id).filter(a => a.test_id === t.id);
      const finished = attempts.find(a => a.finished_at);
      if (finished) {
        status = 'finished'; score = finished.score; total = finished.total; attemptId = finished.id;
      } else if (attempt) {
        const answered = db.getAnsweredQuestionIds(attempt.id).length;
        status = 'in_progress'; attemptId = attempt.id; score = answered; total = attempt.total;
      }
    }
    return { ...t, questionCount, status, score, total, attemptId };
  });
  res.json(result);
});

app.get('/api/tests/:id/questions', (req, res) => {
  const test = db.getTestById(req.params.id);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });
  const questions = db.getQuestionsByTest(req.params.id, false);
  log('INFO', 'test:fetch-questions', { testId: req.params.id, count: questions.length });
  res.json({ test, questions });
});

app.post('/api/attempts', (req, res) => {
  const { testId, token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  let attempt = db.getActiveAttempt(student.id, testId);
  if (!attempt) {
    const id = db.createAttempt(student.id, testId);
    attempt = db.getAttempt(id);
    log('INFO', 'attempt:create', { student: student.name, testId, attemptId: attempt.id });
  } else {
    log('INFO', 'attempt:resume', { student: student.name, testId, attemptId: attempt.id });
  }
  res.json({ attemptId: attempt.id });
});

app.post('/api/answers', (req, res) => {
  const { attemptId, questionId, selectedIndex, token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  const attempt = db.getAttempt(attemptId);
  if (!attempt || attempt.student_id !== student.id) {
    log('WARN', 'answer:access-denied', { student: student.name, attemptId });
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const { isCorrect } = db.saveAnswer(attemptId, questionId, selectedIndex);
  const answered = db.getAnsweredQuestionIds(attemptId).length;
  const test = db.getTestById(attempt.test_id);
  const question = db.getQuestionById(questionId);

  log('ANSWER', 'student:answer', {
    student: student.name,
    test: test?.title,
    q: question?.question?.slice(0, 40),
    selected: question?.options?.[selectedIndex],
    correct: isCorrect,
    progress: `${answered}/${attempt.total}`,
  });

  io.to('admins').emit('admin:student-answered', {
    studentId: student.id,
    name: student.name,
    testTitle: test?.title || '',
    questionNum: answered,
    total: attempt.total,
    isCorrect,
    topic: question?.topic || '',
    questionId,
  });

  res.json({ isCorrect, answered, total: attempt.total });
});

app.post('/api/attempts/:id/finish', (req, res) => {
  const { token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  const attempt = db.finishAttempt(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Попытка не найдена' });
  const test = db.getTestById(attempt.test_id);

  log('INFO', 'attempt:finish', {
    student: student.name,
    test: test?.title,
    score: `${attempt.score}/${attempt.total}`,
    pct: Math.round(100 * attempt.score / attempt.total) + '%',
  });

  io.to('admins').emit('admin:student-finished', {
    studentId: student.id,
    name: student.name,
    testTitle: test?.title || '',
    score: attempt.score,
    total: attempt.total,
  });

  const answers = db.getAnswersByAttempt(req.params.id);
  res.json({ attempt, answers });
});

app.get('/api/results/:attemptId', (req, res) => {
  const token = req.query.token;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  const attempt = db.getAttempt(req.params.attemptId);
  if (!attempt || attempt.student_id !== student.id) return res.status(403).json({ error: 'Нет доступа' });

  const answers = db.getAnswersByAttempt(req.params.attemptId);
  res.json({ attempt, answers });
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.get('/api/admin/tests', adminAuth, (req, res) => {
  const tests = db.getAllTests();
  res.json(tests.map(t => ({ ...t, questionCount: db.getQuestionsByTest(t.id).length })));
});

app.patch('/api/admin/tests/:id', adminAuth, (req, res) => {
  db.setTestActive(req.params.id, req.body.is_active);
  log('INFO', 'admin:test-toggle', { testId: req.params.id, active: req.body.is_active });
  res.json({ ok: true });
});

app.post('/api/admin/tests', adminAuth, (req, res) => {
  const { title, subtitle, chapter } = req.body;
  const id = db.createTest(title, subtitle, chapter);
  log('INFO', 'admin:test-create', { title, id });
  res.json({ id });
});

app.get('/api/admin/results', adminAuth, (req, res) => {
  res.json(db.getAllAttempts());
});

app.get('/api/admin/results/:attemptId', adminAuth, (req, res) => {
  const attempt = db.getAttempt(req.params.attemptId);
  if (!attempt) return res.status(404).json({ error: 'Попытка не найдена' });
  res.json({ attempt, answers: db.getAnswersByAttempt(req.params.attemptId) });
});

app.get('/api/admin/analytics', adminAuth, (req, res) => {
  res.json(db.getTopicAnalytics());
});

// GET /api/admin/student/:studentId/progress — прогресс конкретного ученика
app.get('/api/admin/student/:studentId/progress', adminAuth, (req, res) => {
  res.json(db.getStudentProgress(req.params.studentId));
});

// GET /api/admin/students — список всех учеников
app.get('/api/admin/students', adminAuth, (req, res) => {
  res.json(db.getAllStudents());
});

// GET /api/admin/logs — лог событий сервера
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(logs.slice(-limit).reverse());
});

app.post('/api/admin/questions', adminAuth, (req, res) => {
  const { testId, topic, question, options, correctIndex, explanation, sortOrder } = req.body;
  const id = db.createQuestion(testId, topic, question, options, correctIndex, explanation, sortOrder);
  res.json({ id });
});

app.get('/api/admin/questions/:testId', adminAuth, (req, res) => {
  res.json(db.getQuestionsByTest(req.params.testId, true));
});

app.put('/api/admin/questions/:id', adminAuth, (req, res) => {
  const { topic, question, options, correctIndex, explanation } = req.body;
  db.updateQuestion(req.params.id, topic, question, options, correctIndex, explanation);
  res.json({ ok: true });
});

app.delete('/api/admin/questions/:id', adminAuth, (req, res) => {
  db.deleteQuestion(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/questions/bulk', adminAuth, (req, res) => {
  const { testId, questions } = req.body;
  if (!testId || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'Нужны testId и массив questions' });
  }
  const test = db.getTestById(testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });

  const existing = db.getQuestionsByTest(testId, true);
  let sortOrder = existing.length ? Math.max(...existing.map(q => q.sort_order || 0)) + 1 : 1;

  const ids = [];
  for (const q of questions) {
    const { topic, question, options, correctIndex, explanation } = q;
    if (!topic || !question || !Array.isArray(options) || options.length < 2 ||
        correctIndex == null || correctIndex < 0 || correctIndex >= options.length) {
      return res.status(400).json({ error: `Неверный формат вопроса: ${JSON.stringify(q).slice(0, 80)}` });
    }
    const id = db.createQuestion(testId, topic, question, options, correctIndex, explanation || '', sortOrder++);
    ids.push(id);
  }

  log('INFO', 'admin:bulk-import', { testId, count: ids.length, test: test.title });
  res.json({ imported: ids.length, ids });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const activeStudents = new Map(); // socketId → { studentId, name, testId, testTitle, progress, total, answersLog }

io.on('connection', (socket) => {
  log('INFO', 'socket:connect', { socketId: socket.id });

  socket.on('admin:join', ({ pass }) => {
    if (pass === ADMIN_PASS) {
      socket.join('admins');
      socket.emit('admin:active-students', Array.from(activeStudents.values()));
      log('INFO', 'admin:join', { socketId: socket.id });
    } else {
      log('WARN', 'admin:join-fail', { socketId: socket.id });
    }
  });

  socket.on('student:join', ({ studentId, name }) => {
    activeStudents.set(socket.id, {
      studentId, name, testId: null, testTitle: '—',
      progress: 0, total: 0, answersLog: [],
    });
    io.to('admins').emit('admin:student-joined', { studentId, name });
    log('INFO', 'student:join-socket', { name, studentId });
  });

  socket.on('student:start-test', ({ studentId, testId, testTitle, total }) => {
    const s = activeStudents.get(socket.id);
    if (s) { s.testId = testId; s.testTitle = testTitle; s.total = total; s.progress = 0; s.answersLog = []; }
  });

  socket.on('student:answer', ({ studentId, testId, questionId, selectedIndex, isCorrect, questionNum, total }) => {
    const s = activeStudents.get(socket.id);
    if (s) {
      s.progress = questionNum;
      s.answersLog.push({ questionId, isCorrect, questionNum, time: new Date().toISOString() });
    }
    io.to('admins').emit('admin:student-answered', {
      studentId, name: s?.name || '', testId, questionNum, total, isCorrect,
    });
  });

  socket.on('student:finish', ({ studentId, testId, score, total }) => {
    const s = activeStudents.get(socket.id);
    if (s) { s.finished = true; s.score = score; }
    io.to('admins').emit('admin:student-finished', {
      studentId, name: s?.name || '', testId, score, total,
    });
    log('INFO', 'student:finish-socket', { name: s?.name, score: `${score}/${total}` });
  });

  socket.on('disconnect', () => {
    const s = activeStudents.get(socket.id);
    if (s) {
      io.to('admins').emit('admin:student-left', { studentId: s.studentId, name: s.name });
      log('INFO', 'student:disconnect', { name: s.name });
      activeStudents.delete(socket.id);
    }
  });
});

// ─── SPA fallbacks ────────────────────────────────────────────────────────────

app.get('/student/*', (req, res) => res.sendFile(path.join(__dirname, 'public/student/index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

const VIRTUAL_RANGES = ['192.168.56.', '192.168.99.', '172.17.', '172.18.', '172.19.'];
const HOTSPOT_IP = '192.168.137.1';

function getLanIps() {
  const ifaces = os.networkInterfaces();
  const results = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (ip.startsWith('169.254.')) continue;
      if (VIRTUAL_RANGES.some(r => ip.startsWith(r))) continue;
      results.push({ ip, name });
    }
  }
  results.sort((a, b) => {
    if (a.ip === HOTSPOT_IP) return -1;
    if (b.ip === HOTSPOT_IP) return 1;
    return (b.ip.startsWith('192.168.') ? 1 : 0) - (a.ip.startsWith('192.168.') ? 1 : 0);
  });
  return results;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIps();
  const bestIp = ips[0]?.ip || 'localhost';

  log('INFO', 'server:start', { port: PORT, ip: bestIp });
  console.log('\n\u{1F7E2} Сервер запущен!\n');
  console.log(`   Ученик:  http://${bestIp}:${PORT}/student/`);
  console.log(`   Учитель: http://${bestIp}:${PORT}/admin/`);
  if (ips.length > 1) {
    console.log('\n   Все доступные адреса:');
    ips.forEach(({ ip, name }) => console.log(`     http://${ip}:${PORT}/student/  (${name})`));
  }
  console.log(`\n   Пароль админа: ${ADMIN_PASS}\n`);
});
