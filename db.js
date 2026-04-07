// In-memory хранилище — без SQLite, работает везде
const store = {
  tests:    [],
  questions:[],
  students: [],
  attempts: [],
  answers:  [],
};
const seq = { tests: 0, questions: 0, students: 0, attempts: 0, answers: 0 };
const nextId = (t) => ++seq[t];

// Заглушка — для совместимости с server.js
function getDb() { return null; }

// ─── Tests ───────────────────────────────────────────────────────────────────

function getAllTests() {
  return store.tests.map(t => ({ ...t, questionCount: undefined }));
}

function getActiveTests() {
  return store.tests.filter(t => t.is_active);
}

function getTestById(id) {
  return store.tests.find(t => t.id === Number(id)) || null;
}

function createTest(title, subtitle, chapter) {
  const id = nextId('tests');
  store.tests.push({ id, title, subtitle: subtitle || '', chapter: chapter || '', is_active: 1, created_at: new Date().toISOString() });
  return id;
}

function setTestActive(id, isActive) {
  const t = store.tests.find(t => t.id === Number(id));
  if (t) t.is_active = isActive ? 1 : 0;
}

// ─── Questions ───────────────────────────────────────────────────────────────

function getQuestionsByTest(testId, includeAnswer = false) {
  return store.questions
    .filter(q => q.test_id === Number(testId))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map(q => {
      const out = { id: q.id, test_id: q.test_id, topic: q.topic, question: q.question, options: [...q.options], sort_order: q.sort_order };
      if (includeAnswer) { out.correct_index = q.correct_index; out.explanation = q.explanation; }
      return out;
    });
}

function getQuestionById(id) {
  const q = store.questions.find(q => q.id === Number(id));
  return q ? { ...q, options: [...q.options] } : null;
}

function createQuestion(testId, topic, question, options, correctIndex, explanation, sortOrder) {
  const id = nextId('questions');
  store.questions.push({ id, test_id: Number(testId), topic, question, options: [...options], correct_index: Number(correctIndex), explanation, sort_order: Number(sortOrder) || 0 });
  return id;
}

function updateQuestion(id, topic, question, options, correctIndex, explanation) {
  const q = store.questions.find(q => q.id === Number(id));
  if (q) Object.assign(q, { topic, question, options: [...options], correct_index: Number(correctIndex), explanation });
}

function deleteQuestion(id) {
  const i = store.questions.findIndex(q => q.id === Number(id));
  if (i !== -1) store.questions.splice(i, 1);
}

function countQuestions() {
  return store.questions.length;
}

// ─── Students ─────────────────────────────────────────────────────────────────

function findOrCreateStudent(name, token) {
  let s = store.students.find(s => s.session_token === token);
  if (!s) {
    const id = nextId('students');
    s = { id, name, session_token: token, created_at: new Date().toISOString() };
    store.students.push(s);
  }
  return s;
}

function getStudentByToken(token) {
  return store.students.find(s => s.session_token === token) || null;
}

// ─── Attempts ─────────────────────────────────────────────────────────────────

function createAttempt(studentId, testId) {
  const total = store.questions.filter(q => q.test_id === Number(testId)).length;
  const id = nextId('attempts');
  store.attempts.push({ id, student_id: Number(studentId), test_id: Number(testId), started_at: new Date().toISOString(), finished_at: null, score: null, total });
  return id;
}

function getAttempt(id) {
  return store.attempts.find(a => a.id === Number(id)) || null;
}

function getActiveAttempt(studentId, testId) {
  return store.attempts
    .filter(a => a.student_id === Number(studentId) && a.test_id === Number(testId) && !a.finished_at)
    .sort((a, b) => b.id - a.id)[0] || null;
}

function finishAttempt(attemptId) {
  const attempt = store.attempts.find(a => a.id === Number(attemptId));
  if (!attempt) return null;
  const score = store.answers.filter(a => a.attempt_id === Number(attemptId) && a.is_correct).length;
  attempt.finished_at = new Date().toISOString();
  attempt.score = score;
  return attempt;
}

function getStudentAttempts(studentId) {
  return store.attempts
    .filter(a => a.student_id === Number(studentId))
    .sort((a, b) => b.id - a.id)
    .map(a => {
      const test = store.tests.find(t => t.id === a.test_id);
      return { ...a, test_title: test?.title || '', chapter: test?.chapter || '' };
    });
}

function getAllAttempts() {
  return store.attempts
    .sort((a, b) => b.id - a.id)
    .map(a => {
      const student = store.students.find(s => s.id === a.student_id);
      const test = store.tests.find(t => t.id === a.test_id);
      return { ...a, student_name: student?.name || '', test_title: test?.title || '' };
    });
}

// ─── Answers ──────────────────────────────────────────────────────────────────

function saveAnswer(attemptId, questionId, selectedIndex) {
  const q = store.questions.find(q => q.id === Number(questionId));
  const isCorrect = q && q.correct_index === Number(selectedIndex);

  const existing = store.answers.find(a => a.attempt_id === Number(attemptId) && a.question_id === Number(questionId));
  if (existing) {
    existing.selected_index = Number(selectedIndex);
    existing.is_correct = isCorrect;
    existing.answered_at = new Date().toISOString();
  } else {
    const id = nextId('answers');
    store.answers.push({ id, attempt_id: Number(attemptId), question_id: Number(questionId), selected_index: Number(selectedIndex), is_correct: isCorrect, answered_at: new Date().toISOString() });
  }
  return { isCorrect };
}

function getAnswersByAttempt(attemptId) {
  return store.answers
    .filter(a => a.attempt_id === Number(attemptId))
    .map(a => {
      const q = store.questions.find(q => q.id === a.question_id);
      return { ...a, question: q?.question || '', options: q ? [...q.options] : [], correct_index: q?.correct_index ?? 0, explanation: q?.explanation || '', topic: q?.topic || '' };
    })
    .sort((a, b) => {
      const qa = store.questions.find(q => q.id === a.question_id);
      const qb = store.questions.find(q => q.id === b.question_id);
      return (qa?.sort_order ?? 0) - (qb?.sort_order ?? 0) || a.question_id - b.question_id;
    });
}

function getAnsweredQuestionIds(attemptId) {
  return store.answers.filter(a => a.attempt_id === Number(attemptId)).map(a => a.question_id);
}

// ─── Analytics ────────────────────────────────────────────────────────────────

function getTopicAnalytics() {
  const map = {};
  store.answers.forEach(a => {
    const q = store.questions.find(q => q.id === a.question_id);
    if (!q) return;
    if (!map[q.topic]) map[q.topic] = { topic: q.topic, total_answers: 0, correct_answers: 0 };
    map[q.topic].total_answers++;
    if (a.is_correct) map[q.topic].correct_answers++;
  });
  return Object.values(map)
    .map(r => ({ ...r, pct: r.total_answers ? Math.round(100 * r.correct_answers / r.total_answers * 10) / 10 : 0 }))
    .sort((a, b) => a.pct - b.pct);
}

module.exports = {
  getDb,
  getAllTests, getActiveTests, getTestById, createTest, setTestActive,
  getQuestionsByTest, getQuestionById, createQuestion, updateQuestion, deleteQuestion, countQuestions,
  findOrCreateStudent, getStudentByToken,
  createAttempt, getAttempt, getActiveAttempt, finishAttempt, getStudentAttempts, getAllAttempts,
  saveAnswer, getAnswersByAttempt, getAnsweredQuestionIds,
  getTopicAnalytics,
};
