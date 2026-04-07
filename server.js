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

// ─── Startup ─────────────────────────────────────────────────────────────────

db.getDb(); // init schema
if (db.countQuestions() === 0) {
  console.log('База пуста, загружаем вопросы...');
  seed();
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-pass'] || req.query.pass;
  if (pass === ADMIN_PASS) return next();
  res.status(401).json({ error: 'Неверный пароль администратора' });
}

// ─── Student API ──────────────────────────────────────────────────────────────

// POST /api/student/login  { name } → { token, studentId }
app.post('/api/student/login', (req, res) => {
  const { name, token: existingToken } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя' });

  const token = existingToken || uuidv4();
  const student = db.findOrCreateStudent(name.trim(), token);
  res.json({ token: student.session_token, studentId: student.id, name: student.name });
});

// GET /api/tests  — активные тесты (с прогрессом если передан token)
app.get('/api/tests', (req, res) => {
  const tests = db.getActiveTests();
  const token = req.query.token;
  let student = null;
  if (token) student = db.getStudentByToken(token);

  const result = tests.map(t => {
    const questionCount = db.getQuestionsByTest(t.id).length;
    let status = 'not_started';
    let score = null;
    let attemptId = null;
    if (student) {
      const attempt = db.getActiveAttempt(student.id, t.id);
      const attempts = db.getStudentAttempts(student.id).filter(a => a.test_id === t.id);
      const finished = attempts.find(a => a.finished_at);
      if (finished) {
        status = 'finished';
        score = finished.score;
        total = finished.total;
        attemptId = finished.id;
      } else if (attempt) {
        const answered = db.getAnsweredQuestionIds(attempt.id).length;
        status = 'in_progress';
        attemptId = attempt.id;
        score = answered;
      }
    }
    return { ...t, questionCount, status, score, attemptId };
  });
  res.json(result);
});

// GET /api/tests/:id/questions — без правильных ответов!
app.get('/api/tests/:id/questions', (req, res) => {
  const test = db.getTestById(req.params.id);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });
  const questions = db.getQuestionsByTest(req.params.id, false);
  res.json({ test, questions });
});

// POST /api/attempts  { testId, token } → { attemptId }
app.post('/api/attempts', (req, res) => {
  const { testId, token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  let attempt = db.getActiveAttempt(student.id, testId);
  if (!attempt) {
    const id = db.createAttempt(student.id, testId);
    attempt = db.getAttempt(id);
  }
  res.json({ attemptId: attempt.id });
});

// POST /api/answers  { attemptId, questionId, selectedIndex, token }
app.post('/api/answers', (req, res) => {
  const { attemptId, questionId, selectedIndex, token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  const attempt = db.getAttempt(attemptId);
  if (!attempt || attempt.student_id !== student.id) return res.status(403).json({ error: 'Нет доступа' });

  const { isCorrect } = db.saveAnswer(attemptId, questionId, selectedIndex);

  // Подсчёт прогресса
  const answered = db.getAnsweredQuestionIds(attemptId).length;
  const test = db.getTestById(attempt.test_id);
  const question = db.getQuestionById(questionId);

  // Socket.IO → admin
  io.to('admins').emit('admin:student-answered', {
    studentId: student.id,
    name: student.name,
    testTitle: test ? test.title : '',
    questionNum: answered,
    total: attempt.total,
    isCorrect,
    topic: question ? question.topic : '',
  });

  res.json({ isCorrect, answered, total: attempt.total });
});

// POST /api/attempts/:id/finish  { token }
app.post('/api/attempts/:id/finish', (req, res) => {
  const { token } = req.body;
  const student = db.getStudentByToken(token);
  if (!student) return res.status(401).json({ error: 'Сессия не найдена' });

  const attempt = db.finishAttempt(req.params.id);
  const test = db.getTestById(attempt.test_id);

  // Socket.IO → admin
  io.to('admins').emit('admin:student-finished', {
    studentId: student.id,
    name: student.name,
    testTitle: test ? test.title : '',
    score: attempt.score,
    total: attempt.total,
  });

  // Вернуть полные результаты с правильными ответами
  const answers = db.getAnswersByAttempt(req.params.id);
  res.json({ attempt, answers });
});

// GET /api/results/:attemptId  { ?token }
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

// GET /api/admin/tests
app.get('/api/admin/tests', adminAuth, (req, res) => {
  const tests = db.getAllTests();
  const result = tests.map(t => ({
    ...t,
    questionCount: db.getQuestionsByTest(t.id).length,
  }));
  res.json(result);
});

// PATCH /api/admin/tests/:id  { is_active }
app.patch('/api/admin/tests/:id', adminAuth, (req, res) => {
  db.setTestActive(req.params.id, req.body.is_active);
  res.json({ ok: true });
});

// POST /api/admin/tests  { title, subtitle, chapter }
app.post('/api/admin/tests', adminAuth, (req, res) => {
  const { title, subtitle, chapter } = req.body;
  const id = db.createTest(title, subtitle, chapter);
  res.json({ id });
});

// GET /api/admin/results
app.get('/api/admin/results', adminAuth, (req, res) => {
  res.json(db.getAllAttempts());
});

// GET /api/admin/results/:attemptId  — подробности попытки
app.get('/api/admin/results/:attemptId', adminAuth, (req, res) => {
  const attempt = db.getAttempt(req.params.attemptId);
  if (!attempt) return res.status(404).json({ error: 'Попытка не найдена' });
  const answers = db.getAnswersByAttempt(req.params.attemptId);
  res.json({ attempt, answers });
});

// GET /api/admin/analytics
app.get('/api/admin/analytics', adminAuth, (req, res) => {
  res.json(db.getTopicAnalytics());
});

// POST /api/admin/questions  { testId, topic, question, options, correctIndex, explanation, sortOrder }
app.post('/api/admin/questions', adminAuth, (req, res) => {
  const { testId, topic, question, options, correctIndex, explanation, sortOrder } = req.body;
  const id = db.createQuestion(testId, topic, question, options, correctIndex, explanation, sortOrder);
  res.json({ id });
});

// GET /api/admin/questions/:testId
app.get('/api/admin/questions/:testId', adminAuth, (req, res) => {
  res.json(db.getQuestionsByTest(req.params.testId, true));
});

// PUT /api/admin/questions/:id
app.put('/api/admin/questions/:id', adminAuth, (req, res) => {
  const { topic, question, options, correctIndex, explanation } = req.body;
  db.updateQuestion(req.params.id, topic, question, options, correctIndex, explanation);
  res.json({ ok: true });
});

// DELETE /api/admin/questions/:id
app.delete('/api/admin/questions/:id', adminAuth, (req, res) => {
  db.deleteQuestion(req.params.id);
  res.json({ ok: true });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const activeStudents = new Map(); // socketId → { studentId, name, testId, progress }

io.on('connection', (socket) => {
  // Admin joins admin room
  socket.on('admin:join', ({ pass }) => {
    if (pass === ADMIN_PASS) {
      socket.join('admins');
      // Send current active students
      socket.emit('admin:active-students', Array.from(activeStudents.values()));
    }
  });

  // Student joins
  socket.on('student:join', ({ studentId, name }) => {
    activeStudents.set(socket.id, { studentId, name, testId: null, progress: 0, total: 0 });
    io.to('admins').emit('admin:student-joined', { studentId, name });
  });

  // Student starts test
  socket.on('student:start-test', ({ studentId, testId, testTitle, total }) => {
    const s = activeStudents.get(socket.id);
    if (s) {
      s.testId = testId;
      s.testTitle = testTitle;
      s.total = total;
      s.progress = 0;
    }
  });

  // Student answers (realtime update)
  socket.on('student:answer', ({ studentId, testId, questionId, selectedIndex, isCorrect, questionNum, total }) => {
    const s = activeStudents.get(socket.id);
    if (s) s.progress = questionNum;
    io.to('admins').emit('admin:student-answered', {
      studentId,
      name: s ? s.name : '',
      testId,
      questionNum,
      total,
      isCorrect,
    });
  });

  // Student finishes
  socket.on('student:finish', ({ studentId, testId, score, total }) => {
    const s = activeStudents.get(socket.id);
    io.to('admins').emit('admin:student-finished', {
      studentId,
      name: s ? s.name : '',
      testId,
      score,
      total,
    });
  });

  socket.on('disconnect', () => {
    const s = activeStudents.get(socket.id);
    if (s) {
      io.to('admins').emit('admin:student-left', { studentId: s.studentId, name: s.name });
      activeStudents.delete(socket.id);
    }
  });
});

// ─── SPA fallbacks ────────────────────────────────────────────────────────────

app.get('/student/*', (req, res) => res.sendFile(path.join(__dirname, 'public/student/index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

// Виртуальные адаптеры (VirtualBox, Hyper-V, Docker и т.п.) — пропускаем
const VIRTUAL_RANGES = ['192.168.56.', '192.168.99.', '172.17.', '172.18.', '172.19.'];
const HOTSPOT_IP = '192.168.137.1'; // Windows Mobile Hotspot

function getLanIps() {
  const ifaces = os.networkInterfaces();
  const results = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const iface of addrs) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (ip.startsWith('169.254.')) continue; // APIPA
      if (VIRTUAL_RANGES.some(r => ip.startsWith(r))) continue;
      results.push({ ip, name });
    }
  }
  // Хот-спот Windows — всегда первым
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

  console.log('\n\u{1F7E2} Сервер запущен!\n');
  console.log(`   Ученик:  http://${bestIp}:${PORT}/student/`);
  console.log(`   Учитель: http://${bestIp}:${PORT}/admin/`);

  if (ips.length > 1) {
    console.log('\n   Все доступные адреса:');
    ips.forEach(({ ip, name }) => console.log(`     http://${ip}:${PORT}/student/  (${name})`));
  }

  console.log(`\n   Пароль админа: ${ADMIN_PASS}\n`);
});
