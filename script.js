// ==================== QUIZ ENGINE ====================
import './style.css';

// ==================== HISTORY NAMESPACE ====================
// Persists finished exam results to localStorage. Falls back to an in-memory
// array when localStorage throws (Safari private mode, quota exceeded, or
// localStorage polyfilled to undefined in some embedded WebViews).
const History = {
  key: 'quiz-app.history.exam',
  cap: 50,
  mem: [],

  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return this.mem;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : this.mem;
    } catch (e) {
      console.warn('[history] localStorage unavailable, using memory', e);
      return this.mem;
    }
  },

  save(entry) {
    const list = this.load();
    list.unshift(entry);
    if (list.length > this.cap) list.length = this.cap;
    try {
      localStorage.setItem(this.key, JSON.stringify(list));
    } catch (e) {
      console.warn('[history] localStorage write failed, in-memory only', e);
      this.mem = list;
    }
  },

  clear() {
    try { localStorage.removeItem(this.key); } catch (e) { /* noop */ }
    this.mem = [];
  },

  list() { return this.load(); },
  count() { return this.load().length; }
};

// ==================== LEADERBOARD ====================
// Read URL for the leaderboard.json file. Same repo that the Worker writes
// to — the Worker is the write path, raw.githubusercontent.com is the read
// path (public, cacheable). Update both this constant AND the Worker's
// GH_REPO config when moving repos.
const LEADERBOARD_READ_URL = 'https://raw.githubusercontent.com/Chumr26/quiz-app/main/data/leaderboard.json';

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}m ${String(ss).padStart(2, '0')}s`;
}

function formatScore(score, total) {
  return `${score}/${total}`;
}

// part: 'all' | 0..5 — 5 means "Toàn bộ 200 câu" (the full 200-question run).
function partLabel(part) {
  if (part === 'all' || part === 5) return 'Toàn bộ 200 câu';
  return `Phần ${part + 1} (Câu ${part * 40 + 1}–${(part + 1) * 40})`;
}

function filterEntries(entries, part) {
  if (part === 'all') return entries;
  return entries.filter(e => e.part === part);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => b.score - a.score || a.ms - a.ms);
}

function topN(entries, n = 10) {
  return sortEntries(entries).slice(0, n);
}

function formatHistoryDate(ts) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

function formatHistoryTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

class QuizApp {
  constructor() {
    this.allQuestions = [];   // loaded once, full 200-item set
    this.questions = [];      // 40-item slice for the active part
    this.partIndex = 0;       // 0..4 once a part is chosen
    this.isShowingPicker = true;
    this.currentIndex = 0;
    this.furthestIndex = 0; // tracks the furthest question reached
    this.answers = {}; // { questionIndex: selectedOptionIndex }
    this.results = {}; // { questionIndex: 'correct' | 'incorrect' }
    this.isShowingResult = false;
    this.quizTitle = '';
    this.autoAdvanceTimer = null;
    this.audioCtx = null; // lazy-init on first interaction
    this.touch = { active: false, startX: 0, startY: 0, offset: 0, lastDy: 0 };
    this.lastSwipeDirection = null; // 'right'|'left'|null — set by onTouchEnd, consumed by renderQuizScreen
    this.devMode = localStorage.getItem('quiz-dev-mode') === '1'
      || new URLSearchParams(location.search).get('dev') === '1';

    // 2-mode quiz state (phase 1)
    this.mode = 'practice'; // 'practice' | 'exam'
    this.pickerTab = 'practice'; // tab selected in picker; passed to startPart (phase 2)
    this.examStartTime = 0; // Date.now() when exam starts
    this.examEndTime = 0; // Date.now() when entering results in exam mode
    this.examFinished = false; // guards single-set of examEndTime
    this.firstTryCorrect = {}; // { idx: true } when correct on first attempt
    this.retryCount = {}; // { idx: number } wrong attempts before correct

    // Exam timer (phase 4)
    this._timerIntervalId = null; // setInterval handle for ticking display
    this._pausedAt = 0; // Date.now() when timer paused
    this._onVisibilityChange = null; // bound listener for cleanup

    // History modal (phase 5)
    this.isShowingHistory = false; // toggles the "Xem tất cả" modal

    // Leaderboard state (phase 1)
    this.isShowingLeaderboard = false;
    this.isShowingSettings = false;
    this.currentLeaderboardFilter = 'all'; // 'all' | 0..5
    this.leaderboardCache = { ts: 0, data: null }; // 60s in-memory cache; Phase 2 swaps in real fetch
    this.workerUrl = ''; // read from manifest.json.workerUrl at runtime in Phase 2
    try {
      this.leaderboardName = localStorage.getItem('quiz-app.leaderboardName') || '';
    } catch {
      this.leaderboardName = '';
    }

    this.init();
  }

  async init() {
    await this.loadQuestions();
    await this.loadWorkerUrl();
    this.render();
    this.bindEvents();
    this.bindServiceWorkerUpdates();
  }

  // ==================== DATA LOADING ====================
  async loadQuestions() {
    try {
      const response = await fetch('./questions.json');
      if (!response.ok) throw new Error('Failed to load questions');
      this.allQuestions = await response.json();
      this.quizTitle = `Ôn tập Giáo dục Chính trị`;
    } catch (error) {
      console.error('Error loading questions:', error);
      this.allQuestions = [{
        id: 1,
        question: 'Could not load questions. Please check that questions.json exists.',
        options: ['Reload page'],
        answer: 0
      }];
      this.quizTitle = 'Quiz App';
    }
  }

  // ==================== RENDERING ====================
  render() {
    const container = document.getElementById('quiz-app');
    container.classList.toggle('dev-mode', this.devMode);

    if (this.isShowingLeaderboard) {
      this.renderLeaderboardScreen(container);
      return;
    }

    if (this.isShowingSettings) {
      container.innerHTML = this.renderSettingsScreen();
      return;
    }

    if (this.isShowingPicker) {
      container.innerHTML = this.renderPickerScreen();
      return;
    }

    if (this.isShowingResult) {
      if (this.mode === 'exam' && !this.examFinished) {
        this.examEndTime = Date.now();
        this.examFinished = true;
        this.stopExamTimer();
        // Persist a history entry. The !examFinished guard ensures this runs
        // exactly once per exam even if render() is called again.
        const correctCount = Object.values(this.results).filter(r => r === 'correct').length;
        const total = this.questions.length;
        History.save({
          timestamp: this.examEndTime,
          partIndex: this.partIndex,
          correct: correctCount,
          total,
          percent: Math.round((correctCount / total) * 100),
          elapsedMs: this.examEndTime - this.examStartTime,
          wrongIndices: Object.entries(this.results)
            .filter(([, r]) => r === 'incorrect')
            .map(([i]) => parseInt(i, 10))
        });
      }
      container.innerHTML = this.renderResultsScreen();
      this.animateResultsBar();
      return;
    }

    container.innerHTML = this.renderQuizScreen();
    this.bindTouchListeners();
  }

  // ==================== PART PICKER ====================
  startPart(i, mode = 'practice') {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.partIndex = i;
    if (i === 'full') {
      this.questions = [...this.allQuestions];
    } else {
      const start = i * 40;
      this.questions = this.allQuestions.slice(start, start + 40);
    }
    this.mode = mode;
    this.currentIndex = 0;
    this.furthestIndex = 0;
    this.answers = {};
    this.results = {};
    this.firstTryCorrect = {};
    this.retryCount = {};
    this.examStartTime = mode === 'exam' ? Date.now() : 0;
    this.examEndTime = 0;
    this.examFinished = false;
    this.isShowingResult = false;
    this.isShowingPicker = false;
    history.pushState({ screen: 'quiz' }, '');
    this.render();
    if (mode === 'exam') {
      // Defer 1 frame so the timer span is in the DOM before _renderTimerDisplay queries it.
      setTimeout(() => this.startExamTimer(), 0);
    }
  }

  bindTouchListeners() {
    const content = document.querySelector('.quiz-content');
    if (!content) return;
    // innerHTML replaced the old node, so its listeners are GC'd. Re-bind fresh.
    content.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: true });
    content.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: true });
    content.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: true });
    content.addEventListener('touchcancel', this.onTouchEnd.bind(this), { passive: true });
  }

  renderPane(q, idx, position, swipeFromLeft = false) {
    const paneNum = idx + 1;
    const selectedOption = this.answers[idx];
    const result = this.results[idx];

    return `
      <div class="quiz-pane ${position}" data-position="${position}" data-index="${idx}">
        <div class="question-wrapper ${swipeFromLeft ? 'slide-from-left' : ''}">
          <div class="question-label">Câu ${paneNum}</div>
          <div class="question-text">${q.question}</div>

          <div class="options-list">
            ${q.options.map((opt, i) => this.renderOption(opt, i, selectedOption, result, q.answer)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderQuizScreen() {
    // Consume-and-clear: direction is set on successful swipe in onTouchEnd.
    // Other nav paths leave this null → wrapper keeps the default from-right animation.
    const swipeFromLeft = this.lastSwipeDirection === 'left';
    this.lastSwipeDirection = null;

    const q = this.questions[this.currentIndex];
    const total = this.questions.length;
    const isExam = this.mode === 'exam';

    const timerSpan = isExam
      ? `<span class="exam-timer" id="exam-timer" aria-label="Thời gian làm bài">${this.formatElapsed()}</span>`
      : '';

    return `
      ${this.renderDevToggle()}
      <div class="quiz-content">
        <div class="quiz-stack" id="quiz-stack">
          ${this.renderPane(q, this.currentIndex, 'current', swipeFromLeft)}
        </div>
      </div>
      <div class="quiz-meta-row">${timerSpan}</div>

      ${this.renderProgressBar()}
      ${this.renderGridModal()}
    `;
  }

  renderOption(text, index, selectedOption, result, correctAnswer) {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const letter = letters[index] || String.fromCharCode(65 + index);

    let className = 'option-item';
    let isInteractive = true;

    if (result === 'correct') {
      // Correct answer found — show it, disable everything else
      if (index === correctAnswer) {
        className += ' correct';
      } else {
        className += ' disabled';
      }
      isInteractive = false;
    }

    return `
      <div class="${className}" data-index="${index}" ${isInteractive ? 'role="button" tabindex="0"' : ''}>
        <span class="option-letter">${letter}.</span>
        <span class="option-text">${text}</span>
      </div>
    `;
  }

  renderProgressBar() {
    const total = this.questions.length;

    // Practice mode: mastery bar — counts how many questions are correct.
    if (this.mode === 'practice') {
      const masteredCount = Object.values(this.results).filter(r => r === 'correct').length;
      const segments = this.questions.map((_, i) => {
        const cls = ['seg'];
        if (this.results[i] === 'correct') {
          cls.push(this.firstTryCorrect[i] ? 'seg-first-try' : 'seg-retry');
        } else {
          cls.push('seg-empty');
        }
        if (i === this.currentIndex) cls.push('seg-current');
        return `<div class="${cls.join(' ')}"></div>`;
      }).join('');
      return `
        <div class="progress-rail progress-practice" role="button" tabindex="0" aria-label="Mở danh sách câu hỏi">
          <div class="progress-label">${masteredCount} / ${total} đã thuộc</div>
          <div class="progress-segments">${segments}</div>
        </div>
      `;
    }

    // Exam/dev: continuous-fill bar (existing behavior).
    const current = this.currentIndex + 1;
    const answeredCount = Object.keys(this.results).length;
    const fillPercent = total > 0 ? (answeredCount / total) * 100 : 0;
    return `
      <div class="progress-rail" role="button" tabindex="0">
        <div class="continuous-bar">
          <div class="bar-fill" style="width: ${fillPercent}%"></div>
        </div>
        <div class="rail-meta">
          <span class="question-counter">Câu ${current} / ${total}</span>
          <span class="percentage-label">${Math.round(fillPercent)}% hoàn thành</span>
        </div>
      </div>
    `;
  }

  renderGridModal() {
    let cells = '';
    for (let i = 0; i < this.questions.length; i++) {
      let className = 'grid-cell';
      const isClickable = i !== this.currentIndex && (this.devMode || this.results[i] || i <= this.furthestIndex);
      
      if (this.results[i] === 'correct') {
        className += ' correct';
      } else if (this.results[i] === 'incorrect') {
        className += ' incorrect';
      } else if (i === this.currentIndex) {
        className += ' current';
      }

      if (isClickable) {
        className += ' clickable';
      }

      cells += `<div class="${className}" data-index="${i}" ${isClickable ? 'role="button" tabindex="0"' : ''}>${i + 1}</div>`;
    }

    return `
      <div class="grid-modal" id="grid-modal">
        <div class="grid-backdrop" id="grid-backdrop"></div>
        <div class="grid-sheet">
          <div class="grid-header">
            <span class="grid-title">Chọn câu hỏi</span>
            <button class="icon-btn btn-close-grid">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
          <div class="grid-content">
            <div class="cells-container">${cells}</div>
          </div>
          <div class="grid-legend">
            <span><span class="legend-dot correct"></span> Đúng</span>
            <span><span class="legend-dot incorrect"></span> Sai</span>
            <span><span class="legend-dot current"></span> Đang làm</span>
          </div>
        </div>
      </div>
    `;
  }

  toggleGridModal(show) {
    const modal = document.getElementById('grid-modal');
    if (modal) {
      if (show) {
        modal.classList.add('show');
        // Scroll to current after animation starts
        setTimeout(() => {
          const currentCell = modal.querySelector('.grid-cell.current');
          if (currentCell) {
            currentCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      } else {
        modal.classList.remove('show');
      }
    }
  }

  renderResultsScreen() {
    // Practice mode: congrats-only screen, no score/percentage.
    if (this.mode === 'practice') {
      const total = this.questions.length;
      const mastered = Object.values(this.results).filter(r => r === 'correct').length;
      const firstTry = Object.values(this.firstTryCorrect).filter(Boolean).length;
      const needReview = total - mastered;
      const allDone = mastered === total;
      return `
        ${this.renderDevToggle()}
        <div class="quiz-content">
          <div class="results-screen practice-results">
            <div class="results-icon great">${allDone ? '🎉' : '👍'}</div>
            <div class="results-title">Chúc mừng!</div>
            <div class="results-subtitle">Bạn đã hoàn thành phần ${this.partIndex === 'full' ? 'tổng' : (this.partIndex + 1)}.</div>
            <div class="practice-breakdown">
              <div class="practice-stat">
                <div class="practice-stat-value">${firstTry} / ${total}</div>
                <div class="practice-stat-label">thuộc lần đầu</div>
              </div>
              ${needReview > 0 ? `
                <div class="practice-stat">
                  <div class="practice-stat-value">${needReview}</div>
                  <div class="practice-stat-label">câu cần ôn thêm</div>
                </div>
              ` : ''}
            </div>
            <div class="results-actions">
              <button class="btn btn-outline" id="btn-restart">Học lại phần này</button>
              <button class="btn btn-filled" id="btn-back-picker">Về danh sách phần</button>
            </div>
            ${this.leaderboardName ? `
              <button class="btn btn-outline btn-leaderboard-submit" type="button"
                      data-action="leaderboard-submit"
                      ${this.workerUrl ? '' : 'disabled title="Bảng xếp hạng chưa cấu hình"'}
                      data-mode="${this.mode}" data-part="${this.partIndex}">
                🏆 Gửi điểm lên bảng xếp hạng
              </button>
              <div class="leaderboard-submit-status" data-role="leaderboard-submit-status"></div>
            ` : `
              <p class="leaderboard-hint">Đặt tên trong <button type="button" class="link-btn" data-action="open-settings">Cài đặt</button> để gửi điểm.</p>
            `}
          </div>
        </div>
      `;
    }

    // Exam mode: stats screen with score, time, expandable wrong-list (phase 4 design).
    const total = this.questions.length;
    const correctCount = Object.values(this.results).filter(r => r === 'correct').length;
    const incorrectCount = Object.values(this.results).filter(r => r === 'incorrect').length;
    const unanswered = total - correctCount - incorrectCount;
    const percentage = Math.round((correctCount / total) * 100);

    const wrongIdx = this.questions
      .map((q, i) => ({ q, i }))
      .filter(({ i }) => this.results[i] === 'incorrect');

    return `
      ${this.renderDevToggle()}
      <div class="quiz-content">
        <div class="results-screen exam-results">
          <div class="result-percent">${percentage}%</div>
          <div class="results-title">Kết quả</div>

          <div class="results-stats">
            <div class="stat-item">
              <div class="stat-value correct-val">${correctCount}</div>
              <div class="stat-label">Đúng</div>
            </div>
            <div class="stat-item">
              <div class="stat-value incorrect-val">${incorrectCount}</div>
              <div class="stat-label">Sai</div>
            </div>
            <div class="stat-item">
              <div class="stat-value unanswered-val">${unanswered}</div>
              <div class="stat-label">Chưa làm</div>
            </div>
          </div>

          <div class="exam-time">Thời gian: ${this.formatElapsed()}</div>

          ${wrongIdx.length > 0 ? `
            <details class="wrong-list">
              <summary>Xem ${wrongIdx.length} câu sai</summary>
              <ol>
                ${wrongIdx.map(({ q, i }) => `
                  <li>
                    <div class="wrong-q">${q.question}</div>
                    <div class="wrong-answers">
                      Bạn chọn: ${this.answers[i] !== undefined ? q.options[this.answers[i]] : '(bỏ trống)'}<br>
                      Đáp án đúng: ${q.options[q.answer]}
                    </div>
                  </li>
                `).join('')}
              </ol>
            </details>
          ` : ''}

          <div class="results-actions">
            <button class="btn btn-outline" id="btn-restart">Thử lại</button>
            <button class="btn btn-filled" id="btn-back-picker">Về danh sách phần</button>
          </div>
          ${this.leaderboardName ? `
            <button class="btn btn-outline btn-leaderboard-submit" type="button"
                    data-action="leaderboard-submit"
                    ${this.workerUrl ? '' : 'disabled title="Bảng xếp hạng chưa cấu hình"'}
                    data-mode="${this.mode}" data-part="${this.partIndex}">
              🏆 Gửi điểm lên bảng xếp hạng
            </button>
            <div class="leaderboard-submit-status" data-role="leaderboard-submit-status"></div>
          ` : `
            <p class="leaderboard-hint">Đặt tên trong <button type="button" class="link-btn" data-action="open-settings">Cài đặt</button> để gửi điểm.</p>
          `}
        </div>
      </div>
    `;
  }

  // ==================== LEADERBOARD SCREEN (PHASE 1) ====================
  // Phase 1 renders a hardcoded fixture; Phase 2 swaps the source to a Worker
  // fetch. The DOM is built with createElement + textContent to keep untrusted
  // user-supplied `name` values out of innerHTML interpolation (XSS hardening).
  renderLeaderboardScreen(container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'leaderboard-screen';

    const header = document.createElement('div');
    header.className = 'leaderboard-header';
    const title = document.createElement('h2');
    title.className = 'leaderboard-title';
    title.textContent = 'Bảng xếp hạng';
    const backBtn = document.createElement('button');
    backBtn.className = 'leaderboard-back';
    backBtn.type = 'button';
    backBtn.textContent = '← Quay lại';
    backBtn.dataset.action = 'leaderboard-back';
    header.appendChild(title);
    header.appendChild(backBtn);

    const filterBar = document.createElement('div');
    filterBar.className = 'leaderboard-filter';
    const filterLabel = document.createElement('span');
    filterLabel.className = 'leaderboard-filter-label';
    filterLabel.textContent = 'Phần:';
    const select = document.createElement('select');
    select.className = 'leaderboard-select';
    select.dataset.action = 'leaderboard-filter';
    const options = [
      { value: 'all', label: 'Tất cả' },
      { value: 5, label: 'Toàn bộ 200 câu' },
      { value: 0, label: 'Phần 1' },
      { value: 1, label: 'Phần 2' },
      { value: 2, label: 'Phần 3' },
      { value: 3, label: 'Phần 4' },
      { value: 4, label: 'Phần 5' },
    ];
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      if (String(opt.value) === String(this.currentLeaderboardFilter)) o.selected = true;
      select.appendChild(o);
    });
    filterBar.appendChild(filterLabel);
    filterBar.appendChild(select);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'leaderboard-refresh';
    refreshBtn.type = 'button';
    refreshBtn.textContent = '↻ Làm mới';
    refreshBtn.dataset.action = 'leaderboard-refresh';

    const status = document.createElement('div');
    status.className = 'leaderboard-status';
    status.textContent = '';

    const body = document.createElement('div');
    body.className = 'leaderboard-body';

    wrap.appendChild(header);
    wrap.appendChild(filterBar);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(status);
    wrap.appendChild(body);
    container.appendChild(wrap);

    // Initial paint from cache (if any); fall through to fetch below.
    if (this.leaderboardCache.data?.entries) {
      this._paintLeaderboardBody(body, { kind: 'ok', entries: this.leaderboardCache.data.entries });
    } else if (!this.workerUrl) {
      this._paintLeaderboardBody(body, { kind: 'error', cause: 'network' });
    } else {
      this._paintLeaderboardBody(body, { kind: 'loading' });
    }

    if (this.workerUrl) {
      this.fetchLeaderboard()
        .then((entries) => {
          this._paintLeaderboardBody(body, { kind: 'ok', entries });
        })
        .catch(() => {
          // Cache fallback: if we have any prior data, keep showing it with an
          // "Offline" badge. Otherwise show the error state explicitly.
          if (this.leaderboardCache.data?.entries) {
            this._paintLeaderboardBody(body, { kind: 'ok', entries: this.leaderboardCache.data.entries });
            status.textContent = 'Offline — hiển thị dữ liệu cũ.';
          } else {
            this._paintLeaderboardBody(body, { kind: 'error', cause: 'network' });
          }
        });
    }
  }

  // RenderState discriminated union: loading | ok | empty | error.
  // empty and error are mutually exclusive — never both, never neither.
  _paintLeaderboardBody(body, state) {
    body.innerHTML = '';
    if (state.kind === 'loading') {
      const p = document.createElement('p');
      p.className = 'leaderboard-loading';
      p.textContent = 'Đang tải…';
      body.appendChild(p);
      return;
    }
    if (state.kind === 'error') {
      const p = document.createElement('p');
      p.className = 'leaderboard-error';
      p.textContent = state.cause === 'network'
        ? 'Không tải được bảng xếp hạng. Kiểm tra mạng.'
        : 'Không tải được bảng xếp hạng. Dữ liệu bị lỗi.';
      body.appendChild(p);
      return;
    }
    // state.kind === 'ok': build rows
    const list = document.createElement('ol');
    list.className = 'leaderboard-list';
    const filtered = filterEntries(state.entries, this.currentLeaderboardFilter);
    const rows = topN(filtered, 10);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'Chưa có ai gửi điểm. Hãy là người đầu tiên!';
      body.appendChild(empty);
      return;
    }
    rows.forEach((entry, idx) => {
      const li = document.createElement('li');
      li.className = 'leaderboard-row';

      const rank = document.createElement('span');
      rank.className = `leaderboard-rank leaderboard-medal-${Math.min(idx + 1, 3)}`;
      rank.textContent = `#${idx + 1}`;

      const name = document.createElement('span');
      name.className = 'leaderboard-name';
      name.textContent = entry.name;

      const part = document.createElement('span');
      part.className = 'leaderboard-part';
      part.textContent = partLabel(entry.part);

      const score = document.createElement('span');
      score.className = 'leaderboard-score';
      score.textContent = formatScore(entry.score, entry.total);

      const time = document.createElement('span');
      time.className = 'leaderboard-time';
      time.textContent = formatDuration(entry.ms);

      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(part);
      li.appendChild(score);
      li.appendChild(time);
      list.appendChild(li);
    });
    body.appendChild(list);
  }

  // ==================== LEADERBOARD DATA (PHASE 2) ====================
  // Reads workerUrl from manifest.json once at startup; uses an in-memory
  // 60-second cache. Cache dies on tab close — acceptable, just a slower
  // first paint after navigation. `dev=1` is NOT forwarded to the Worker.
  async loadWorkerUrl() {
    if (this.workerUrl) return;
    try {
      const r = await fetch('./manifest.json', { cache: 'no-cache' });
      if (!r.ok) return;
      const m = await r.json();
      this.workerUrl = (m && typeof m.workerUrl === 'string') ? m.workerUrl : '';
    } catch {
      this.workerUrl = '';
    }
    if (this.devMode && !this.workerUrl) {
      console.warn('[DEV] leaderboard submissions disabled (workerUrl empty).');
    }
  }

  async fetchLeaderboard({ force = false } = {}) {
    if (!force && this.leaderboardCache.data && Date.now() - this.leaderboardCache.ts < 60_000) {
      return this.leaderboardCache.data.entries;
    }
    try {
      const r = await fetch(`${LEADERBOARD_READ_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json();
      if (!data || !Array.isArray(data.entries)) throw new Error('bad shape');
      this.leaderboardCache = { ts: Date.now(), data };
      return data.entries;
    } catch (err) {
      if (this.leaderboardCache.data) return this.leaderboardCache.data.entries;
      throw err;
    }
  }

  clearLeaderboardCache() {
    this.leaderboardCache = { ts: 0, data: null };
  }

  async submitScore(entry) {
    if (!this.workerUrl) {
      return { ok: false, kind: 'unconfigured', message: 'Bảng xếp hạng chưa cấu hình.' };
    }
    const translateReason = (reason) => {
      // Worker-side validation messages come back in English; map known ones.
      const map = {
        'name required': 'Thiếu tên.',
        'name 1-30 chars [A-Za-zÀ-ỹ0-9 _.-]': 'Tên không hợp lệ (1–30 ký tự, chữ/số/khoảng trắng).',
        'part 0-5': 'Phần không hợp lệ (0–5).',
        'score 0-200': 'Điểm không hợp lệ (0–200).',
        'total 40 or 200': 'Tổng câu không hợp lệ (40 hoặc 200).',
        'ms >= 0': 'Thời gian không hợp lệ.',
        'total mismatch with part': 'Phần và tổng câu không khớp.',
        'bad json': 'Dữ liệu gửi lên bị lỗi.',
      };
      return map[reason] || reason;
    };

    const handle = async () => {
      try {
        const r = await fetch(`${this.workerUrl}/api/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) {
          this.leaderboardCache.ts = 0; // force bypass on next read
          return { ok: true, message: 'Đã gửi! Điểm sẽ xuất hiện trong khoảng 30 giây.' };
        }
        // Map status + body.error → Vietnamese message
        if (r.status === 400 && body?.error === 'validation') {
          return { ok: false, kind: 'validation', message: `Lỗi: ${translateReason(body.reason)}` };
        }
        if (r.status === 429) {
          const retryMin = Math.ceil(parseInt(r.headers.get('Retry-After') || '600', 10) / 60);
          return { ok: false, kind: 'ratelimit', message: `Bạn gửi quá nhiều. Thử lại sau ${retryMin} phút.` };
        }
        if (r.status === 503) {
          switch (body?.error) {
            case 'config':
              return { ok: false, kind: 'config', message: 'Bảng xếp hạng tạm thời đóng. Liên hệ admin.' };
            case 'quota':
              return { ok: false, kind: 'quota', message: 'Bảng xếp hạng tạm thời đóng (đã đạt giới hạn ngày).' };
            case 'race':
            case 'upstream':
              return { ok: false, kind: body.error, retry: body.retry !== false, message: 'Lỗi mạng. Thử lại.' };
            default:
              return { ok: false, kind: 'unknown', message: 'Lỗi mạng. Thử lại.' };
          }
        }
        return { ok: false, kind: 'unknown', message: `Lỗi máy chủ (HTTP ${r.status}).` };
      } catch (err) {
        return { ok: false, kind: 'network', message: 'Lỗi mạng. Kiểm tra kết tra.' };
      }
    };

    // First attempt
    let result = await handle();
    // Auto-retry once for race condition (probabilistic SHA conflict)
    if (!result.ok && result.kind === 'race' && result.retry) {
      await new Promise(r => setTimeout(r, 2000));
      result = await handle();
    }
    return result;
  }

  // Minimal toast: position-fixed pill, auto-dismiss after 4 s.
  showToast(message, type = 'info') {
    const existing = document.querySelector('.quiz-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = `quiz-toast quiz-toast-${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
  }

  renderSettingsScreen() {
    return `
      <div class="settings-screen">
        <div class="settings-header">
          <button class="settings-back" type="button" data-action="settings-back">← Quay lại</button>
          <h2 class="settings-title">Cài đặt</h2>
        </div>
        <div class="settings-section">
          <label class="settings-label" for="settings-name">Tên hiển thị trên bảng xếp hạng</label>
          <input class="settings-input" id="settings-name" type="text"
                 maxlength="24" placeholder="Ví dụ: An"
                 value="${this.leaderboardName.replace(/"/g, '&quot;')}" />
          <p class="settings-hint">Tối đa 24 ký tự. Khi trống, nút gửi bảng xếp hạng sẽ bị ẩn.</p>
        </div>
        <button class="settings-save" type="button" data-action="settings-save">Lưu</button>
        <div class="settings-status" data-role="settings-status"></div>
      </div>
    `;
  }

  // Floating "DEV ON/OFF" button rendered on all 3 screens. position: fixed
  // in CSS pins it to the top-right corner regardless of where in the DOM it
  // lives, so the templates can drop it at the top of the screen.
  renderDevToggle() {
    return `
      <button class="dev-toggle ${this.devMode ? 'on' : 'off'}"
              title="${this.devMode ? 'Disable dev mode' : 'Enable dev mode'}"
              aria-label="Toggle dev mode"
              aria-pressed="${this.devMode}">
        DEV ${this.devMode ? 'ON' : 'OFF'}
      </button>
    `;
  }

  // ==================== PART PICKER SCREEN ====================
  renderPickerScreen() {
    const partSize = 40;
    const total = this.allQuestions.length;
    const totalParts = Math.ceil(total / partSize);
    const tab = this.pickerTab;
    const fullCard = `
      <button class="part-card part-card-full" data-mode="full" type="button">
        <span class="part-card-title">Toàn bộ ${total} câu</span>
      </button>
    `;
    const partCards = Array.from({ length: totalParts }, (_, i) => {
      const start = i * partSize + 1;
      const end = Math.min((i + 1) * partSize, total);
      return `
        <button class="part-card" data-part-index="${i}" type="button">
          <span class="part-card-title">Câu ${start} – ${end}</span>
        </button>
      `;
    }).join('');
    return `
      <div class="quiz-header picker-header">
        <div class="picker-title">
          <div class="picker-title-text">
            <span class="picker-eyebrow">Chế độ</span>
            <h1 class="picker-display">Giáo dục Chính trị</h1>
          </div>
        </div>
      </div>
      ${this.renderDevToggle()}
      <div class="quiz-content">
        <div class="picker-tabs" role="tablist">
          <button class="picker-tab ${tab === 'practice' ? 'active' : ''}"
                  data-pick-mode="practice"
                  role="tab"
                  aria-selected="${tab === 'practice'}"
                  type="button">
            Ôn tập
          </button>
          <button class="picker-tab ${tab === 'exam' ? 'active' : ''}"
                  data-pick-mode="exam"
                  role="tab"
                  aria-selected="${tab === 'exam'}"
                  type="button">
            Kiểm tra
          </button>
        </div>
        <div class="part-picker">${fullCard}${partCards}</div>
        ${this.renderHistorySection()}
        <div class="picker-nav">
          <button class="picker-nav-btn" type="button" data-action="open-leaderboard">
            🏆 Bảng xếp hạng
          </button>
          <button class="picker-nav-btn" type="button" data-action="open-settings">
            ⚙ Cài đặt
          </button>
        </div>
      </div>
      ${this.isShowingHistory ? this.renderHistoryModal() : ''}
    `;
  }

  renderHistorySection() {
    const items = History.list();
    if (items.length === 0) return '';
    const recent = items.slice(0, 5);
    const rows = recent.map(entry => `
      <li class="history-row">
        <span class="history-date">${formatHistoryDate(entry.timestamp)}</span>
        <span class="history-part">Phần ${entry.partIndex === 'full' ? 'tổng' : entry.partIndex + 1}</span>
        <span class="history-score">${entry.percent}%</span>
        <span class="history-time">${formatHistoryTime(entry.elapsedMs)}</span>
      </li>
    `).join('');
    return `
      <section class="history-section">
        <h3>Lịch sử kiểm tra gần đây</h3>
        <ol class="history-list">${rows}</ol>
        ${items.length > 5 ? `
          <button class="view-all-history-btn" type="button">Xem tất cả (${items.length})</button>
        ` : ''}
      </section>
    `;
  }

  renderHistoryModal() {
    const items = History.list();
    const rows = items.map(entry => `
      <li class="history-row">
        <span class="history-date">${formatHistoryDate(entry.timestamp)}</span>
        <span class="history-part">Phần ${entry.partIndex === 'full' ? 'tổng' : entry.partIndex + 1}</span>
        <span class="history-score">${entry.percent}%</span>
        <span class="history-time">${formatHistoryTime(entry.elapsedMs)}</span>
      </li>
    `).join('');
    return `
      <div class="modal history-modal show" id="history-modal">
        <div class="modal-backdrop" data-action="close-history"></div>
        <div class="modal-content">
          <div class="modal-header">
            <h3>Lịch sử kiểm tra</h3>
            <button class="icon-btn" data-action="close-history" aria-label="Đóng">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>
            </button>
          </div>
          <ol class="history-list full">${rows || '<li class="history-empty">Chưa có lịch sử.</li>'}</ol>
          <div class="modal-actions">
            <button class="btn btn-danger" id="btn-clear-history" type="button">Xóa lịch sử</button>
            <button class="btn btn-outline" data-action="close-history" type="button">Đóng</button>
          </div>
        </div>
      </div>
    `;
  }

  pickMode(mode) {
    if (mode !== 'practice' && mode !== 'exam') return;
    if (this.pickerTab === mode) return;
    this.pickerTab = mode;
    if (this.isShowingPicker) this.render();
  }

  // ==================== EVENT HANDLING ====================
  // Attached exactly once in init(). render() replaces #quiz-app children only,
  // so this delegated listener on the parent survives every rebuild.
  bindEvents() {
    const appEl = document.getElementById('quiz-app');

    appEl.addEventListener('click', (e) => {
      const target = e.target;

      // Dev mode toggle (position: fixed, top-right) — checked first so a click
      // on the button never bubbles to .part-card / .option-item / .grid-cell.
      const devToggle = target.closest('.dev-toggle');
      if (devToggle) {
        this.setDevMode(!this.devMode);
        return;
      }

      // Picker tab switch (phase 2)
      const pickerTab = target.closest('.picker-tab');
      if (pickerTab) {
        this.pickMode(pickerTab.dataset.pickMode);
        return;
      }

      // Leaderboard: open from picker
      if (target.closest('[data-action="open-leaderboard"]')) {
        this.isShowingLeaderboard = true;
        this.isShowingSettings = false;
        this.isShowingPicker = false;
        this.render();
        return;
      }

      // Settings: open from picker
      if (target.closest('[data-action="open-settings"]')) {
        this.isShowingSettings = true;
        this.isShowingLeaderboard = false;
        this.isShowingPicker = false;
        this.render();
        return;
      }

      // Leaderboard: back to picker
      if (target.closest('[data-action="leaderboard-back"]')) {
        this.backToPicker();
        return;
      }

      // Leaderboard: refresh (re-fetch, bypass cache)
      if (target.closest('[data-action="leaderboard-refresh"]')) {
        const body = document.querySelector('.leaderboard-body');
        const status = document.querySelector('.leaderboard-status');
        if (!this.workerUrl) {
          if (status) status.textContent = 'Bảng xếp hạng chưa cấu hình.';
          return;
        }
        if (status) status.textContent = 'Đang tải…';
        this.clearLeaderboardCache();
        this.fetchLeaderboard({ force: true })
          .then((entries) => {
            if (status) status.textContent = 'Đã cập nhật.';
            if (body) this._paintLeaderboardBody(body, { kind: 'ok', entries });
          })
          .catch(() => {
            if (status) status.textContent = 'Không tải được. Thử lại sau.';
          });
        return;
      }

      // Leaderboard: submit score from results screen
      if (target.closest('[data-action="leaderboard-submit"]')) {
        const btn = target.closest('[data-action="leaderboard-submit"]');
        const status = document.querySelector('[data-role="leaderboard-submit-status"]');
        if (!this.workerUrl) {
          if (status) status.textContent = 'Bảng xếp hạng chưa cấu hình.';
          return;
        }
        if (!this.leaderboardName) {
          if (status) status.textContent = 'Đặt tên trong Cài đặt trước.';
          return;
        }
        const mode = btn.dataset.mode || 'practice';
        const partRaw = btn.dataset.part;
        const part = partRaw === 'full' ? 5 : parseInt(partRaw, 10);
        const correctCount = Object.values(this.results).filter(r => r === 'correct').length;
        const total = this.questions.length;
        const isExam = mode === 'exam';
        const elapsedMs = isExam
          ? (this.examEndTime && this.examStartTime ? this.examEndTime - this.examStartTime : 0)
          : Date.now() - (this.examStartTime || Date.now());
        const entry = {
          name: this.leaderboardName,
          part,
          score: correctCount,
          total,
          ms: elapsedMs,
        };
        btn.disabled = true;
        if (status) status.textContent = 'Đang gửi…';
        this.submitScore(entry).then((result) => {
          btn.disabled = false;
          if (status) status.textContent = result.message;
          if (result.ok) btn.textContent = '✓ Đã gửi';
        });
        return;
      }

      // Settings: back to picker
      if (target.closest('[data-action="settings-back"]')) {
        this.backToPicker();
        return;
      }

      // Settings: save name
      if (target.closest('[data-action="settings-save"]')) {
        const input = document.getElementById('settings-name');
        const status = document.querySelector('[data-role="settings-status"]');
        const next = (input?.value || '').trim().slice(0, 24);
        this.leaderboardName = next;
        try {
          if (next) localStorage.setItem('quiz-app.leaderboardName', next);
          else localStorage.removeItem('quiz-app.leaderboardName');
        } catch { /* storage may be unavailable */ }
        if (status) status.textContent = next ? `Đã lưu tên "${next}".` : 'Đã xóa tên.';
        return;
      }

      // Part-picker card (placed first so it wins over option/segment routes)
      const partCard = target.closest('.part-card');
      if (partCard) {
        const partIdx = partCard.dataset.mode === 'full' ? 'full' : parseInt(partCard.dataset.partIndex);
        this.startPart(partIdx, this.pickerTab);
        return;
      }

      // History: view all (phase 5)
      if (target.closest('.view-all-history-btn')) {
        this.isShowingHistory = true;
        this.render();
        return;
      }

      // History: close modal
      if (target.closest('[data-action="close-history"]')) {
        this.isShowingHistory = false;
        this.render();
        return;
      }

      // History: clear
      if (target.closest('#btn-clear-history')) {
        if (confirm('Xóa toàn bộ lịch sử kiểm tra?')) {
          History.clear();
          this.isShowingHistory = false;
          this.render();
        }
        return;
      }

      // Option click
      const option = target.closest('.option-item[role="button"]');
      if (option) {
        this.selectOption(parseInt(option.dataset.index));
        return;
      }

      // Progress rail click (open grid modal)
      if (target.closest('.progress-rail')) {
        this.toggleGridModal(true);
        return;
      }

      // Close grid modal
      if (target.closest('.btn-close-grid') || target.classList.contains('grid-backdrop')) {
        this.toggleGridModal(false);
        return;
      }

      // Grid cell click
      const cell = target.closest('.grid-cell.clickable');
      if (cell) {
        const idx = parseInt(cell.dataset.index);
        this.goToQuestion(idx);
        return;
      }

      // Restart
      if (target.closest('#btn-restart')) {
        this.restart();
        return;
      }

      // Review
      if (target.closest('#btn-review')) {
        this.review();
        return;
      }

      // Back to picker
      if (target.closest('#btn-back-picker')) {
        this.backToPicker();
        return;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (this.isShowingResult) return;

      switch (e.key) {
        case 'ArrowLeft':
          this.goBack();
          break;
        case 'ArrowRight':
          this.tryGoForward();
          break;
        case '1': case 'a': case 'A':
          this.selectOption(0);
          break;
        case '2': case 'b': case 'B':
          this.selectOption(1);
          break;
        case '3': case 'c': case 'C':
          this.selectOption(2);
          break;
        case '4': case 'd': case 'D':
          this.selectOption(3);
          break;
      }
    });

    window.addEventListener('popstate', () => {
      if (!this.isShowingPicker && !this.isShowingResult) {
        this.backToPicker();
      }
    });

    // Leaderboard filter dropdown — re-renders only the list, no full re-render
    // so the user's selection isn't lost mid-interaction.
    appEl.addEventListener('change', (e) => {
      const target = e.target;
      if (target.closest('[data-action="leaderboard-filter"]')) {
        const raw = target.value;
        this.currentLeaderboardFilter = raw === 'all' ? 'all' : parseInt(raw, 10);
        const body = document.querySelector('.leaderboard-body');
        if (body && this.leaderboardCache.data?.entries) {
          this._paintLeaderboardBody(body, { kind: 'ok', entries: this.leaderboardCache.data.entries });
        }
      }
    });
  }

  // New SW has activated and taken control of this page — reload once so the
  // cached script.js/style.css we already loaded gets replaced by the new shell.
  // Guard against loops with a window-scoped flag set on the first reload.
  bindServiceWorkerUpdates() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.__swReloading) return;
      window.__swReloading = true;
      location.reload();
    });
  }

  // ==================== HAPTIC & SOUND FEEDBACK ====================
  vibrate(pattern) {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  }

  getAudioCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  playCorrectSound() {
    try {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;

      [523.25, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle'; // triangle is perceptually louder than sine
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, now + i * 0.12); 
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.5);
      });
    } catch (e) { /* silent fail */ }
  }

  playWrongSound() {
    try {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 200;
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.linearRampToValueAtTime(150, now + 0.15);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch (e) { /* silent fail */ }
  }

  // ==================== NAVIGATION WRAPPERS (return success) ====================
  tryGoBack() {
    if (this.currentIndex > 0) {
      this.goBack();
      return true;
    }
    return false;
  }

  tryGoForward() {
    const target = this.currentIndex + 1;
    // At the last question, return false so the gated snap-back fires instead
    // of going out of bounds. Exam auto-advances on answer, so furthestIndex
    // stays in sync with answered progress — no exam-mode bypass needed.
    if (target >= this.questions.length) return false;
    if (this.devMode || target <= this.furthestIndex) {
      this.goToQuestion(target);
      return true;
    }
    return false;
  }

  // ==================== TOUCH HANDLERS ====================
  onTouchStart(e) {
    if (this.isShowingResult) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this.touch = {
      active: true,
      // `swiping` is added lazily on first qualifying move (see onTouchMove),
      // so a tap on an option still receives its synthetic click.
      armSwipingClass: true,
      startX: t.clientX,
      startY: t.clientY,
      offset: 0,
      lastDy: 0,
    };
  }

  onTouchMove(e) {
    if (!this.touch.active) return;
    // Second finger landed — abort this swipe so a stale end doesn't fire a navigation.
    if (e.touches.length !== 1) {
      this.abortSwipe();
      return;
    }
    const t = e.touches[0];
    const dx = t.clientX - this.touch.startX;
    const dy = t.clientY - this.touch.startY;
    this.touch.offset = dx;
    this.touch.lastDy = dy;

    const el = document.querySelector('.quiz-content');
    if (!el) return;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    // Small deadzone before we touch the transform.
    if (absX < 6 && absY < 6) return;

    // Crossed deadzone — now safe to apply .swiping (which disables pointer-events
    // on children so the trailing synthetic click can't fire mid-swipe).
    if (this.touch.armSwipingClass) {
      el.classList.add('swiping');
      this.touch.armSwipingClass = false;
    }

    // Only translate when horizontal dominates; otherwise let native vertical scroll work.
    el.style.setProperty('--swipe-offset', absX > absY ? `${dx}px` : '0px');
  }

  abortSwipe() {
    this.touch.active = false;
    const el = document.querySelector('.quiz-content');
    if (!el) return;
    el.style.transition = 'transform 180ms ease-out';
    el.style.setProperty('--swipe-offset', '0px');
    setTimeout(() => {
      el.style.transition = '';
      el.classList.remove('swiping');
    }, 200);
  }

  // Shared snap-back: gated-swipe path and under-threshold path both fall
  // through here so the user sees identical feedback whether the swipe failed
  // to navigate (edge case) or never qualified (under 50px / diagonal).
  snapBack(el) {
    el.style.transition = 'transform 180ms ease-out';
    el.style.setProperty('--swipe-offset', '0px');
    setTimeout(() => {
      el.style.transition = '';
      el.classList.remove('swiping');
    }, 200);
  }

  onTouchEnd(e) {
    if (!this.touch.active) return;
    // Another finger is still down — don't navigate, just snap back.
    if (e && e.touches && e.touches.length > 0) {
      this.abortSwipe();
      return;
    }
    const { offset, lastDy } = this.touch;
    const absX = Math.abs(offset);
    const absY = Math.abs(lastDy);
    this.touch.active = false;

    const el = document.querySelector('.quiz-content');
    if (!el) {
      this.touch = { active: false, startX: 0, startY: 0, offset: 0, lastDy: 0 };
      return;
    }

    // Horizontal gate: ≥50px movement AND |Δy/Δx| < 0.6 (≈ 30° from horizontal).
    const isHorizontal = absX >= 50 && absX > absY / 0.6;

    if (isHorizontal) {
      // New pane enters FROM the side opposite the finger's pull:
      // swipe LEFT (offset<0) → next from the RIGHT; swipe RIGHT → previous from the LEFT.
      // Set this BEFORE the navigation call — tryGoBack/tryGoForward render synchronously
      // and consume lastSwipeDirection from the very next render call.
      this.lastSwipeDirection = offset < 0 ? 'right' : 'left';
      const moved = offset < 0 ? this.tryGoForward() : this.tryGoBack();
      if (moved) {
        // Navigation will re-render; clear offset so the new node starts clean.
        el.style.setProperty('--swipe-offset', '0px');
        el.classList.remove('swiping');
        return;
      }
      // Navigation didn't fire (e.g., gated by furthestIndex) — undo the direction.
      this.lastSwipeDirection = null;
      // At edge → snap back via shared helper (same as under-threshold).
      this.snapBack(el);
      return;
    }

    // Diagonal / vertical / under-threshold → snap back via shared helper.
    this.snapBack(el);
  }

  // ==================== ACTIONS ====================
  selectOption(index) {
    // Prevent re-selection if already answered correctly
    if (this.results[this.currentIndex] === 'correct') return;

    // Check answer
    const q = this.questions[this.currentIndex];
    const isCorrect = index === q.answer;
    const idx = this.currentIndex;

    if (this.mode === 'practice') {
      // Practice mode: stay-until-correct. Correct → 600ms auto-advance.
      if (isCorrect) {
        this.firstTryCorrect[idx] = (this.retryCount[idx] || 0) === 0;
        this.answers[idx] = index;
        this.results[idx] = 'correct';
        this.vibrate(50);
        this.playCorrectSound();

        // Patch in place: mark the picked option correct, disable the others.
        const picked = document.querySelector(`.option-item[data-index="${index}"]`);
        if (picked) picked.classList.add('correct');
        document.querySelectorAll('.options-list .option-item').forEach((el) => {
          if (el.dataset.index !== String(index)) el.classList.add('disabled');
        });

        if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
        this.autoAdvanceTimer = setTimeout(() => {
          if (this.currentIndex < this.questions.length - 1) {
            this.currentIndex++;
            this.furthestIndex = Math.max(this.furthestIndex, this.currentIndex);
            this.render();
          } else if (Object.keys(this.results).length === this.questions.length) {
            this.isShowingResult = true;
            this.render();
          }
        }, 600);
      } else {
        // Practice wrong: count retry, do NOT set results, no auto-advance.
        this.retryCount[idx] = (this.retryCount[idx] || 0) + 1;
        const wrongEl = document.querySelector(`.option-item[data-index="${index}"]`);
        if (wrongEl) {
          this.vibrate([40, 30, 40]);
          this.playWrongSound();
          wrongEl.classList.add('incorrect');
          setTimeout(() => wrongEl.classList.remove('incorrect'), 500);
        }
      }
      return;
    }

    // mode === 'exam': record selection immediately, no auto-advance.
    if (isCorrect) {
      this.answers[idx] = index;
      this.results[idx] = 'correct';
      this.vibrate(50);
      this.playCorrectSound();
    } else {
      this.answers[idx] = index;
      this.results[idx] = 'incorrect';
      this.vibrate([40, 30, 40]);
      this.playWrongSound();
    }

    // If this was the last question, jump to results screen.
    if (Object.keys(this.results).length === this.questions.length) {
      this.isShowingResult = true;
    }
    this.render();
  }

  goToQuestion(index) {
    // Allow navigating to any answered question or any up to furthest reached.
    // In dev mode, bypass the furthestIndex gate so all questions are reachable.
    // Exam auto-advances on answer so furthestIndex tracks answered progress;
    // no exam-mode bypass is needed.
    if (index === this.currentIndex) return;
    if (!this.devMode && index > this.furthestIndex) return;

    // Clear any pending auto-advance
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);

    this.currentIndex = index;
    this.isShowingResult = false;
    this.render();
  }

  goBack() {
    if (this.currentIndex > 0) {
      // Clear any pending auto-advance
      if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);

      this.currentIndex--;
      this.render();
    }
  }

  setDevMode(on) {
    this.devMode = on;
    if (on) {
      localStorage.setItem('quiz-dev-mode', '1');
    } else {
      localStorage.removeItem('quiz-dev-mode');
    }

    // Mirror to URL so refresh/share preserves the toggle.
    const url = new URL(location.href);
    if (on) url.searchParams.set('dev', '1');
    else url.searchParams.delete('dev');
    history.replaceState(null, '', url);

    this.render();
  }

  restart() {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.currentIndex = 0;
    this.furthestIndex = 0;
    this.answers = {};
    this.results = {};
    this.firstTryCorrect = {};
    this.retryCount = {};
    this.examStartTime = this.mode === 'exam' ? Date.now() : 0;
    this.examEndTime = 0;
    this.examFinished = false;
    this.isShowingResult = false;
    this.render();
  }

  backToPicker() {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.questions = [];
    this.currentIndex = 0;
    this.furthestIndex = 0;
    this.answers = {};
    this.results = {};
    this.firstTryCorrect = {};
    this.retryCount = {};
    this.examStartTime = 0;
    this.examEndTime = 0;
    this.examFinished = false;
    this.isShowingResult = false;
    this.isShowingLeaderboard = false;
    this.isShowingSettings = false;
    this.isShowingPicker = true;
    this.render();
  }

  review() {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.currentIndex = 0;
    this.isShowingResult = false;
    this.render();
  }

  animateResultsBar() {
    const total = this.questions.length;
    const correctCount = Object.values(this.results).filter(r => r === 'correct').length;
    const percentage = Math.round((correctCount / total) * 100);

    requestAnimationFrame(() => {
      setTimeout(() => {
        const bar = document.getElementById('results-bar-fill');
        if (bar) {
          bar.style.width = `${percentage}%`;
        }
      }, 100);
    });
  }

  // ==================== EXAM TIMER (phase 4) ====================
  formatElapsed() {
    const start = this.examStartTime;
    const end = this.examEndTime || Date.now();
    if (!start) return '00:00';
    const ms = Math.max(0, end - start);
    const totalSec = Math.floor(ms / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  startExamTimer() {
    if (this._timerIntervalId) return; // guard re-entry
    this._renderTimerDisplay();
    this._timerIntervalId = setInterval(() => this._tickTimer(), 1000);
    this._onVisibilityChange = () => {
      if (document.hidden) this._pauseTimer();
      else this._resumeTimer();
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  stopExamTimer() {
    if (this._timerIntervalId) {
      clearInterval(this._timerIntervalId);
      this._timerIntervalId = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  _tickTimer() {
    if (document.hidden) return;
    this._renderTimerDisplay();
  }

  _pauseTimer() {
    if (!this._timerIntervalId) return;
    clearInterval(this._timerIntervalId);
    this._timerIntervalId = null;
    this._pausedAt = Date.now();
  }

  _resumeTimer() {
    if (this._timerIntervalId) return;
    if (this._pausedAt && this.examStartTime) {
      // Shift start forward by the pause duration so wall-time elapsed stays accurate.
      const pauseDuration = Date.now() - this._pausedAt;
      this.examStartTime += pauseDuration;
      this._pausedAt = 0;
    }
    this._timerIntervalId = setInterval(() => this._tickTimer(), 1000);
    this._renderTimerDisplay();
  }

  _renderTimerDisplay() {
    const el = document.getElementById('exam-timer');
    if (el) el.textContent = this.formatElapsed();
  }
}

// ==================== INITIALIZE ====================
document.addEventListener('DOMContentLoaded', () => {
  new QuizApp();
});
