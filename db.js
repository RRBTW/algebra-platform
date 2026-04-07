const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'algebra.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT,
      chapter TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER REFERENCES tests(id),
      topic TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      explanation TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      session_token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id),
      test_id INTEGER REFERENCES tests(id),
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      score INTEGER,
      total INTEGER
    );

    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER REFERENCES attempts(id),
      question_id INTEGER REFERENCES questions(id),
      selected_index INTEGER,
      is_correct INTEGER,
      answered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function getAllTests() {
  return getDb().prepare('SELECT * FROM tests ORDER BY id').all();
}

function getActiveTests() {
  return getDb().prepare('SELECT * FROM tests WHERE is_active = 1 ORDER BY id').all();
}

function getTestById(id) {
  return getDb().prepare('SELECT * FROM tests WHERE id = ?').get(id);
}

function createTest(title, subtitle, chapter) {
  const r = getDb().prepare('INSERT INTO tests (title, subtitle, chapter) VALUES (?, ?, ?)').run(title, subtitle, chapter);
  return Number(r.lastInsertRowid);
}

function setTestActive(id, isActive) {
  getDb().prepare('UPDATE tests SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, Number(id));
}

// ─── Questions ───────────────────────────────────────────────────────────────

function getQuestionsByTest(testId, includeAnswer = false) {
  const rows = getDb().prepare('SELECT * FROM questions WHERE test_id = ? ORDER BY sort_order, id').all(Number(testId));
  return rows.map(r => {
    const q = {
      id: r.id,
      test_id: r.test_id,
      topic: r.topic,
      question: r.question,
      options: JSON.parse(r.options),
      sort_order: r.sort_order,
    };
    if (includeAnswer) {
      q.correct_index = r.correct_index;
      q.explanation = r.explanation;
    }
    return q;
  });
}

function getQuestionById(id) {
  const r = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(Number(id));
  if (!r) return null;
  return { ...r, options: JSON.parse(r.options) };
}

function createQuestion(testId, topic, question, options, correctIndex, explanation, sortOrder) {
  const r = getDb().prepare(
    'INSERT INTO questions (test_id, topic, question, options, correct_index, explanation, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(Number(testId), topic, question, JSON.stringify(options), Number(correctIndex), explanation, Number(sortOrder) || 0);
  return Number(r.lastInsertRowid);
}

function updateQuestion(id, topic, question, options, correctIndex, explanation) {
  getDb().prepare(
    'UPDATE questions SET topic=?, question=?, options=?, correct_index=?, explanation=? WHERE id=?'
  ).run(topic, question, JSON.stringify(options), Number(correctIndex), explanation, Number(id));
}

function deleteQuestion(id) {
  getDb().prepare('DELETE FROM questions WHERE id = ?').run(Number(id));
}

function countQuestions() {
  return getDb().prepare('SELECT COUNT(*) as c FROM questions').get().c;
}

// ─── Students ─────────────────────────────────────────────────────────────────

function findOrCreateStudent(name, token) {
  const existing = getDb().prepare('SELECT * FROM students WHERE session_token = ?').get(token);
  if (existing) return existing;
  const r = getDb().prepare('INSERT INTO students (name, session_token) VALUES (?, ?)').run(name, token);
  return getDb().prepare('SELECT * FROM students WHERE id = ?').get(Number(r.lastInsertRowid));
}

function getStudentByToken(token) {
  return getDb().prepare('SELECT * FROM students WHERE session_token = ?').get(token);
}

// ─── Attempts ─────────────────────────────────────────────────────────────────

function createAttempt(studentId, testId) {
  const total = getDb().prepare('SELECT COUNT(*) as c FROM questions WHERE test_id = ?').get(Number(testId)).c;
  const r = getDb().prepare('INSERT INTO attempts (student_id, test_id, total) VALUES (?, ?, ?)').run(Number(studentId), Number(testId), Number(total));
  return Number(r.lastInsertRowid);
}

function getAttempt(id) {
  return getDb().prepare('SELECT * FROM attempts WHERE id = ?').get(Number(id));
}

function getActiveAttempt(studentId, testId) {
  return getDb().prepare(
    'SELECT * FROM attempts WHERE student_id = ? AND test_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(Number(studentId), Number(testId));
}

function finishAttempt(attemptId) {
  const score = getDb().prepare('SELECT COUNT(*) as c FROM answers WHERE attempt_id = ? AND is_correct = 1').get(Number(attemptId)).c;
  getDb().prepare('UPDATE attempts SET finished_at = datetime(\'now\'), score = ? WHERE id = ?').run(Number(score), Number(attemptId));
  return getAttempt(attemptId);
}

function getStudentAttempts(studentId) {
  return getDb().prepare(`
    SELECT a.*, t.title as test_title, t.chapter
    FROM attempts a JOIN tests t ON a.test_id = t.id
    WHERE a.student_id = ?
    ORDER BY a.id DESC
  `).all(Number(studentId));
}

function getAllAttempts() {
  return getDb().prepare(`
    SELECT a.*, s.name as student_name, t.title as test_title
    FROM attempts a
    JOIN students s ON a.student_id = s.id
    JOIN tests t ON a.test_id = t.id
    ORDER BY a.id DESC
  `).all();
}

// ─── Answers ──────────────────────────────────────────────────────────────────

function saveAnswer(attemptId, questionId, selectedIndex) {
  const q = getDb().prepare('SELECT correct_index FROM questions WHERE id = ?').get(Number(questionId));
  const isCorrect = q && q.correct_index === Number(selectedIndex) ? 1 : 0;

  const existing = getDb().prepare('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?').get(Number(attemptId), Number(questionId));
  if (existing) {
    getDb().prepare('UPDATE answers SET selected_index=?, is_correct=?, answered_at=datetime(\'now\') WHERE id=?')
      .run(Number(selectedIndex), isCorrect, Number(existing.id));
  } else {
    getDb().prepare('INSERT INTO answers (attempt_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?)')
      .run(Number(attemptId), Number(questionId), Number(selectedIndex), isCorrect);
  }
  return { isCorrect: Boolean(isCorrect) };
}

function getAnswersByAttempt(attemptId) {
  return getDb().prepare(`
    SELECT ans.*, q.question, q.options, q.correct_index, q.explanation, q.topic
    FROM answers ans
    JOIN questions q ON ans.question_id = q.id
    WHERE ans.attempt_id = ?
    ORDER BY q.sort_order, q.id
  `).all(Number(attemptId)).map(r => ({ ...r, options: JSON.parse(r.options) }));
}

function getAnsweredQuestionIds(attemptId) {
  return getDb().prepare('SELECT question_id FROM answers WHERE attempt_id = ?').all(Number(attemptId)).map(r => r.question_id);
}

// ─── Analytics ────────────────────────────────────────────────────────────────

function getTopicAnalytics() {
  return getDb().prepare(`
    SELECT q.topic,
           COUNT(ans.id) as total_answers,
           SUM(ans.is_correct) as correct_answers,
           ROUND(100.0 * SUM(ans.is_correct) / COUNT(ans.id), 1) as pct
    FROM answers ans
    JOIN questions q ON ans.question_id = q.id
    GROUP BY q.topic
    ORDER BY pct ASC
  `).all();
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
