// ==================== QUIZ ENGINE ====================
import './style.css';

class QuizApp {
  constructor() {
    this.questions = [];
    this.currentIndex = 0;
    this.furthestIndex = 0; // tracks the furthest question reached
    this.answers = {}; // { questionIndex: selectedOptionIndex }
    this.results = {}; // { questionIndex: 'correct' | 'incorrect' }
    this.isShowingResult = false;
    this.quizTitle = '';
    this.autoAdvanceTimer = null;
    this.audioCtx = null; // lazy-init on first interaction

    this.init();
  }

  async init() {
    await this.loadQuestions();
    this.render();
    this.bindEvents();
  }

  // ==================== DATA LOADING ====================
  async loadQuestions() {
    try {
      const response = await fetch('./questions.json');
      if (!response.ok) throw new Error('Failed to load questions');
      this.questions = await response.json();
      this.quizTitle = `Trọn bộ ${this.questions.length} câu ôn tập Giáo dục Chính trị`;
    } catch (error) {
      console.error('Error loading questions:', error);
      this.questions = [{
        id: 1,
        question: 'Could not load questions. Please check that questions.json exists.',
        options: ['Reload page'],
        answer: 0,
        hint: 'Make sure questions.json is in the same folder as index.html.'
      }];
      this.quizTitle = 'Quiz App';
    }
  }

  // ==================== RENDERING ====================
  render() {
    const container = document.getElementById('quiz-app');

    if (this.isShowingResult) {
      container.innerHTML = this.renderResultsScreen();
      this.animateResultsBar();
      return;
    }

    container.innerHTML = this.renderQuizScreen();
  }

  renderQuizScreen() {
    const q = this.questions[this.currentIndex];
    const total = this.questions.length;
    const current = this.currentIndex + 1;
    const selectedOption = this.answers[this.currentIndex];
    const result = this.results[this.currentIndex];

    return `
      <div class="quiz-header">
        <div class="header-top">
          <span class="quiz-title" title="${this.quizTitle}">${this.quizTitle}</span>
        </div>
      </div>

      <div class="progress-section">
        <div class="progress-bar">
          ${this.renderProgressSegments()}
        </div>
        <span class="question-counter">${current} / ${total}</span>
      </div>

      <div class="quiz-content">
        <div class="question-wrapper" id="question-wrapper">
          <div class="question-label">Question ${current}</div>
          <div class="question-text">${q.question}</div>

          <div class="options-list">
            ${q.options.map((opt, i) => this.renderOption(opt, i, selectedOption, result, q.answer)).join('')}
          </div>
        </div>
      </div>

      <div class="quiz-footer">
        <button class="btn btn-outline" id="btn-back" ${this.currentIndex === 0 ? 'disabled' : ''}>Back</button>
      </div>
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
        <svg class="option-icon check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <svg class="option-icon cross-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </div>
    `;
  }

  renderProgressSegments() {
    return this.questions.map((_, i) => {
      let className = 'progress-segment';
      // Allow clicking any answered question, any before current, or the furthest reached
      const isClickable = i !== this.currentIndex && (this.results[i] || i <= this.furthestIndex);

      if (this.results[i] === 'correct') {
        className += ' answered-correct';
      } else if (this.results[i] === 'incorrect') {
        className += ' answered-incorrect';
      } else if (i === this.currentIndex) {
        className += ' active';
      } else if (i < this.currentIndex) {
        className += ' completed';
      }

      if (isClickable) {
        className += ' clickable';
      }

      return `<div class="${className}" data-seg-index="${i}" ${isClickable ? 'role="button" tabindex="0"' : ''}></div>`;
    }).join('');
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
            <button class="btn btn-filled" id="btn-restart">Làm lại</button>
          </div>
        </div>
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

      // Option click
      const option = target.closest('.option-item[role="button"]');
      if (option) {
        this.selectOption(parseInt(option.dataset.index));
        return;
      }

      // Progress segment click (go back only)
      const segment = target.closest('.progress-segment.clickable');
      if (segment) {
        const segIndex = parseInt(segment.dataset.segIndex);
        this.goToQuestion(segIndex);
        return;
      }

      // Back button
      if (target.closest('#btn-back')) {
        this.goBack();
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
    });

    document.addEventListener('keydown', (e) => {
      if (this.isShowingResult) return;

      switch (e.key) {
        case 'ArrowLeft':
          this.goBack();
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
    // Allow navigating to any answered question or any up to furthest reached
    if (index === this.currentIndex) return;
    if (index > this.furthestIndex) return;

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
