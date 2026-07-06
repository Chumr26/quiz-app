// ==================== QUIZ ENGINE ====================
import './style.css';

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
    this.devMode = new URLSearchParams(location.search).get('dev') === '1';

    this.init();
  }

  async init() {
    await this.loadQuestions();
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

    if (this.isShowingPicker) {
      container.innerHTML = this.renderPickerScreen();
      return;
    }

    if (this.isShowingResult) {
      container.innerHTML = this.renderResultsScreen();
      this.animateResultsBar();
      return;
    }

    container.innerHTML = this.renderQuizScreen();
    this.bindTouchListeners();
  }

  // ==================== PART PICKER ====================
  startPart(i) {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.partIndex = i;
    if (i === 'full') {
      this.questions = [...this.allQuestions];
    } else {
      const start = i * 40;
      this.questions = this.allQuestions.slice(start, start + 40);
    }
    this.currentIndex = 0;
    this.furthestIndex = 0;
    this.answers = {};
    this.results = {};
    this.isShowingResult = false;
    this.isShowingPicker = false;
    this.render();
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
    const current = this.currentIndex + 1;

    return `
      <div class="quiz-header">
        <div class="header-top">
          <span class="quiz-title" title="${this.quizTitle}">${this.quizTitle}</span>
          ${this.devMode ? '<span class="dev-badge">DEV</span>' : ''}
        </div>
      </div>

      <div class="quiz-content">
        <div class="quiz-stack" id="quiz-stack">
          ${this.renderPane(q, this.currentIndex, 'current', swipeFromLeft)}
        </div>
      </div>

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
    const current = this.currentIndex + 1;
    const answeredCount = Object.keys(this.results).length;
    const fillPercent = total > 0 ? (answeredCount / total) * 100 : 0;
    const markerPercent = total > 1 ? (this.currentIndex / (total - 1)) * 100 : 0;

    return `
      <div class="progress-rail" role="button" tabindex="0">
        <div class="continuous-bar">
          <div class="bar-fill" style="width: ${fillPercent}%"></div>
          <div class="bar-marker" style="left: ${markerPercent}%"></div>
        </div>
        <div class="rail-meta">
          <span class="question-counter">Câu ${current} / ${total}</span>
          <span class="percentage-label">${Math.round(fillPercent)}% hoàn thành</span>
        </div>
      </div>
    `;
  }

  renderProgressSegments() {
    return this.questions.map((_, i) => {
      const status = this.results[i];
      const cls = status === 'correct' ? 'answered-correct'
        : status === 'incorrect' ? 'answered-incorrect'
        : '';
      return `<div class="progress-segment ${cls}"></div>`;
    }).join('');
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
    const total = this.questions.length;
    const correctCount = Object.values(this.results).filter(r => r === 'correct').length;
    const incorrectCount = total - correctCount;
    const percentage = Math.round((correctCount / total) * 100);

    let iconClass, emoji, title, subtitle;
    if (percentage >= 80) {
      iconClass = 'great';
      emoji = '🎉';
      title = 'Xuất sắc!';
      subtitle = 'Bạn đã nắm vững kiến thức rất tốt.';
    } else if (percentage >= 50) {
      iconClass = 'good';
      emoji = '👍';
      title = 'Khá tốt!';
      subtitle = 'Bạn cần ôn tập thêm một số phần.';
    } else {
      iconClass = 'needs-work';
      emoji = '📚';
      title = 'Cần cố gắng thêm!';
      subtitle = 'Hãy ôn tập lại và thử lại nhé.';
    }

    return `
      <div class="quiz-header">
        <div class="header-top">
          <span class="quiz-title">${this.quizTitle}</span>
          ${this.devMode ? '<span class="dev-badge">DEV</span>' : ''}
        </div>
      </div>

      <div class="progress-section">
        <div class="progress-bar">
          ${this.renderProgressSegments()}
        </div>
        <span class="question-counter">${total} / ${total}</span>
      </div>

      <div class="quiz-content">
        <div class="results-screen">
          <div class="results-icon ${iconClass}">${emoji}</div>
          <div class="results-title">${title}</div>
          <div class="results-subtitle">${subtitle}</div>

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
              <div class="stat-value total-val">${percentage}%</div>
              <div class="stat-label">Tỉ lệ</div>
            </div>
          </div>

          <div class="results-bar">
            <div class="results-bar-fill" id="results-bar-fill" style="width: 0%"></div>
          </div>

          <div class="results-actions">
            <button class="btn btn-outline" id="btn-review">Xem lại</button>
            <button class="btn btn-outline" id="btn-restart">Làm lại phần này</button>
            <button class="btn btn-filled" id="btn-back-picker">Chọn phần khác</button>
          </div>
        </div>
      </div>
    `;
  }

  // ==================== PART PICKER SCREEN ====================
  renderPickerScreen() {
    const partSize = 40;
    const total = this.allQuestions.length;
    const totalParts = Math.ceil(total / partSize);
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
      <div class="quiz-header">
        <div class="header-top">
          <span class="quiz-title">Ôn tập Giáo dục Chính trị</span>
          ${this.devMode ? '<span class="dev-badge">DEV</span>' : ''}
        </div>
      </div>
      <div class="quiz-content">
        <div class="part-picker">${fullCard}${partCards}</div>
      </div>
    `;
  }

  // ==================== EVENT HANDLING ====================
  // Attached exactly once in init(). render() replaces #quiz-app children only,
  // so this delegated listener on the parent survives every rebuild.
  bindEvents() {
    const appEl = document.getElementById('quiz-app');

    appEl.addEventListener('click', (e) => {
      const target = e.target;

      // Part-picker card (placed first so it wins over option/segment routes)
      const partCard = target.closest('.part-card');
      if (partCard) {
        this.startPart(partCard.dataset.mode === 'full' ? 'full' : parseInt(partCard.dataset.partIndex));
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
    // At the last question, return false so the bump animation plays instead of
    // going out of bounds. In dev mode, bypass the furthestIndex gate so swipes
    // can traverse freely between questions.
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
      // At edge → bump feedback then snap back.
      el.classList.add('swipe-bump');
      setTimeout(() => {
        el.classList.remove('swipe-bump');
        el.style.setProperty('--swipe-offset', '0px');
        el.classList.remove('swiping');
      }, 220);
      return;
    }

    // Diagonal / vertical / under-threshold → smooth snap back.
    el.style.transition = 'transform 180ms ease-out';
    el.style.setProperty('--swipe-offset', '0px');
    setTimeout(() => {
      el.style.transition = '';
      el.classList.remove('swiping');
    }, 200);
  }

  // ==================== ACTIONS ====================
  selectOption(index) {
    // Prevent re-selection if already answered correctly
    if (this.results[this.currentIndex] === 'correct') return;

    // Check answer
    const q = this.questions[this.currentIndex];
    const isCorrect = index === q.answer;

    if (isCorrect) {
      this.vibrate(50);
      this.playCorrectSound();
      this.answers[this.currentIndex] = index;
      this.results[this.currentIndex] = 'correct';

      // Patch in place: mark the picked option correct, disable the others.
      // No innerHTML rebuild here — keeps focus, CSS transitions, and screen-reader state.
      const picked = document.querySelector(`.option-item[data-index="${index}"]`);
      if (picked) picked.classList.add('correct');
      document.querySelectorAll('.options-list .option-item').forEach((el) => {
        if (el.dataset.index !== String(index)) el.classList.add('disabled');
      });

      // Auto-advance after short delay (this IS a real content change, so re-render is legitimate)
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
      }, 800);
    } else {
      // Wrong answer — flash red briefly, then just remove the class.
      // No rebuild: the DOM still represents the correct question, no auto-advance fires.
      const wrongEl = document.querySelector(`.option-item[data-index="${index}"]`);
      if (wrongEl) {
        this.vibrate([40, 30, 40]);
        this.playWrongSound();
        wrongEl.classList.add('incorrect');

        setTimeout(() => {
          wrongEl.classList.remove('incorrect');
        }, 500);
      }
    }
  }

  goToQuestion(index) {
    // Allow navigating to any answered question or any up to furthest reached.
    // In dev mode, bypass the furthestIndex gate so all questions are reachable.
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

  restart() {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    this.currentIndex = 0;
    this.furthestIndex = 0;
    this.answers = {};
    this.results = {};
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
    this.isShowingResult = false;
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
}

// ==================== INITIALIZE ====================
document.addEventListener('DOMContentLoaded', () => {
  new QuizApp();
});
