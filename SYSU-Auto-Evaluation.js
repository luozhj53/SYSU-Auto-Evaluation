// ==UserScript==
// @name               中大自动评教
// @name:en            SYSU Auto Evaluation
// @name:zh            中大自动评教
// @namespace          https://github.com/luozhj53/sysu-auto-evaluation
// @version            1.0.1
// @description        中山大学评教系统学生自动评教脚本（基于 KumaTea 的原版脚本进行 Vue/iView 重构）
// @description:en     Automatic Script for Student Evaluation from Academic Affairs System of Sun Yat-sen University (Refactored Version based on KumaTea's original script)
// @description:zh     中山大学评教系统学生自动评教脚本（基于 KumaTea 的原版脚本进行 Vue/iView 重构）
// @description:zh-cn  中山大学评教系统学生自动评教脚本（基于 KumaTea 的原版脚本进行 Vue/iView 重构）
// @author             luozhj53 (Based on the work of KumaTea)
// @match              https://pjxt.sysu.edu.cn/*
// @require            https://unpkg.com/sweetalert@2.1.2/dist/sweetalert.min.js
// @grant              GM_setValue
// @grant              GM_getValue
// @grant              unsafeWindow
// @run-at             document-end
// @license            MIT
// ==/UserScript==

/* jshint esversion: 8 */

/**
 * 致谢 (Acknowledgments):
 * 本脚本的自动化流程控制、延迟防封设计以及 SweetAlert 弹窗通知的基础架构启发自 KumaTea 的原版脚本。
 * 原脚本链接: https://greasyfork.org/zh-CN/scripts/417056 (GitHub: https://github.com/KumaTea)
 * 感谢原作者对中大学生自动评教做出的早期开创性贡献！
 */

const CONFIG = {
  delay: 1500,           // 操作间延迟 (ms)
  pageLoadDelay: 3000,   // 页面加载延迟 (ms)
  sliderValue: 100,      // 滑动条分值 (0-100)
  checkInterval: 1000,   // 状态检查轮询间隔 (ms)
  timeoutLimit: 30000,   // 无响应超时限制 (30 秒)
};

const STATE_KEY = 'auto_eval_state';
const COMPLETED_COUNT_KEY = 'auto_eval_completed_count';
const LAST_ACTION_TIME_KEY = 'auto_eval_last_action_time';

let backAttempts = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全获取当前执行环境的 Window 和 Document (兼容沙箱及原生环境)
 */
function getPageWindow() {
  return (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
}

function getPageDocument() {
  return getPageWindow().document;
}

/**
 * 跨子域及沙箱状态共享：使用 Tampermonkey 全局共享存储
 */
function setShareData(key, value) {
  if (typeof GM_setValue !== 'undefined') {
    GM_setValue(key, value);
  } else {
    // 兼容普通控制台调试
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn("Storage write failed:", e);
    }
  }
}

function getShareData(key) {
  if (typeof GM_getValue !== 'undefined') {
    return GM_getValue(key, null);
  } else {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
}

/**
 * 更新最后活跃时间，防止超时停用
 */
function keepAlive() {
  setShareData(LAST_ACTION_TIME_KEY, Date.now().toString());
}

/**
 * 判断元素在页面中是否可见（忽略被 v-show/display:none 隐藏的 Vue 缓存组件）
 */
function isElementVisible(el) {
  if (!el) return false;
  return el.offsetWidth > 0 || el.offsetHeight > 0 || el.offsetParent !== null;
}

/**
 * 原生方式设置 input 值并触发 React/Vue 兼容事件
 */
function setNativeValue(element, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  valueSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 填答所有选择题（勾选最右侧最好的选项）
 */
function processRadioButtons() {
  let selectedCount = 0;
  const doc = getPageDocument();

  // 策略 1：iview 自定义单选框组 (.ivu-radio-group)
  doc.querySelectorAll('.ivu-radio-group').forEach(group => {
    if (!isElementVisible(group)) return;
    const options = group.querySelectorAll('.ivu-radio-wrapper');
    if (options.length > 0) {
      const lastOption = options[options.length - 1];
      if (!lastOption.classList.contains('ivu-radio-wrapper-checked')) {
        const input = lastOption.querySelector('input[type="radio"]');
        if (input) {
          input.click();
        } else {
          lastOption.click();
        }
        selectedCount++;
      }
    }
  });

  // 策略 2：表格矩阵题，按行 (tr) 寻找
  doc.querySelectorAll('tr').forEach(row => {
    if (!isElementVisible(row)) return;
    const options = row.querySelectorAll('.ivu-radio-wrapper');
    if (options.length > 1) {
      const lastOption = options[options.length - 1];
      if (!lastOption.classList.contains('ivu-radio-wrapper-checked')) {
        const input = lastOption.querySelector('input[type="radio"]');
        if (input) {
          input.click();
        } else {
          lastOption.click();
        }
        selectedCount++;
      }
    }
  });

  // 策略 3：原生 Radio（以 name 分组）作为兜底
  const radioNames = new Set();
  doc.querySelectorAll('input[type="radio"]').forEach(radio => {
    if (isElementVisible(radio) && radio.name) {
      radioNames.add(radio.name);
    }
  });
  radioNames.forEach(name => {
    const radios = doc.querySelectorAll(`input[type="radio"][name="${name}"]`);
    if (radios.length > 0) {
      const lastRadio = radios[radios.length - 1];
      if (!lastRadio.checked) {
        lastRadio.click();
        selectedCount++;
      }
    }
  });

  return selectedCount;
}

/**
 * 拖拽滑动条至满分 (100)
 */
function processSliders() {
  let sliderCount = 0;
  const doc = getPageDocument();
  const win = getPageWindow();

  doc.querySelectorAll('.ivu-slider').forEach(slider => {
    if (!isElementVisible(slider)) return;
    let filled = false;

    // 方法 A：尝试通过 Vue 实例直接修改数据 (最安全且直接)
    if (slider.__vue__) {
      try {
        slider.__vue__.currentValue = CONFIG.sliderValue;
        slider.__vue__.$emit('input', CONFIG.sliderValue);
        slider.__vue__.$emit('on-change', CONFIG.sliderValue);
        filled = true;
      } catch (e) {
        console.error("[AutoEval] 无法通过 Vue 实例修改滑动条:", e);
      }
    }

    // 方法 B：模拟鼠标点击滑动轨道的右端 (DOM 级事件模拟)
    const track = slider.querySelector('.ivu-slider-wrap') || slider;
    if (track) {
      try {
        const rect = track.getBoundingClientRect();
        const clientX = rect.left + rect.width * 0.98; // 设定在 98% 宽度处点击
        const clientY = rect.top + rect.height / 2;

        const mousedown = new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX: clientX,
          clientY: clientY
        });

        const mouseup = new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: win,
          clientX: clientX,
          clientY: clientY
        });

        track.dispatchEvent(mousedown);
        track.dispatchEvent(mouseup);
        filled = true;
      } catch (e) {
        console.error("[AutoEval] 无法模拟点击滑动条轨道:", e);
      }
    }

    // 方法 C：原生 Range input 兼容兜底
    const nativeRange = slider.querySelector('input[type="range"]');
    if (nativeRange) {
      try {
        setNativeValue(nativeRange, CONFIG.sliderValue);
        filled = true;
      } catch (e) {
        console.error("[AutoEval] 无法修改原生 range 滑动条:", e);
      }
    }

    if (filled) {
      sliderCount++;
    }
  });

  return sliderCount;
}

/**
 * 填答主观题（自动填充好评，防止因空字数阻碍提交）
 */
function processTextareas() {
  let count = 0;
  const praiseText = "老师授课认真负责，教学重难点突出，讲解生动清晰，对待学生耐心和蔼，非常感谢老师的悉心指导。";
  const doc = getPageDocument();

  doc.querySelectorAll('textarea.ivu-input, textarea').forEach(textarea => {
    if (isElementVisible(textarea) && !textarea.value.trim()) {
      textarea.value = praiseText;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      count++;
    }
  });
  return count;
}

/**
 * 异步轮询点击“提交”按钮并确认弹窗
 */
async function submitAndConfirm() {
  const doc = getPageDocument();
  const win = getPageWindow();

  // 查找“提交”按钮
  const submitBtn = (() => {
    const btns = Array.from(doc.querySelectorAll('button, a, .ivu-btn'));
    for (const btn of btns) {
      if (!isElementVisible(btn)) continue;
      const text = btn.textContent.trim();
      if (text === '提交' || text === 'Submit') {
        return btn;
      }
    }
    return null;
  })();

  if (!submitBtn) {
    console.error("[AutoEval] 未找到提交按钮");
    return false;
  }

  submitBtn.click();
  keepAlive();
  await sleep(CONFIG.delay);

  // 轮询查找并点击“确定”/“确认”确认按钮（由于 iview 弹窗有渐变动画延迟）
  for (let i = 0; i < 10; i++) {
    const confirmBtn = (() => {
      const elList = Array.from(doc.querySelectorAll('button, a, .ivu-btn, span'));
      for (const el of elList) {
        if (!isElementVisible(el)) continue;
        const text = el.textContent.trim();
        if (text === '确定' || text === 'OK' || text === '确认' || text === 'ok') {
          return el;
        }
      }
      return null;
    })();

    if (confirmBtn) {
      // 更新完成计数
      let completedCount = parseInt(getShareData(COMPLETED_COUNT_KEY) || '0', 10);
      setShareData(COMPLETED_COUNT_KEY, (completedCount + 1).toString());

      confirmBtn.click();
      keepAlive();
      await sleep(CONFIG.pageLoadDelay); // 等待跳转返回
      return true;
    }
    await sleep(300); // 每 300ms 检查一次
  }

  console.error("[AutoEval] 未找到弹出的确定按钮，提交可能失败。");
  return false;
}

/**
 * 寻找“返回”按钮
 */
function findBackButton() {
  const doc = getPageDocument();
  const btns = Array.from(doc.querySelectorAll('button, a, .ivu-btn'));
  for (const btn of btns) {
    if (!isElementVisible(btn)) continue;
    const text = btn.textContent.trim();
    if (text === '返回' || text === '返回列表' || text === 'Back') {
      return btn;
    }
  }
  return null;
}

/**
 * 页面判断辅助函数：彻底去除 URL 绑定，纯依靠当前屏幕可见的 DOM 特征来进行判断
 */
function isParentListPage() {
  const doc = getPageDocument();
  // 一级任务分类列表页包含“任务名称”、“总评数”、“已评数”等可见列头
  const hasTaskHeaders = Array.from(doc.querySelectorAll('th')).some(th => {
    if (!isElementVisible(th)) return false;
    const text = th.textContent.trim();
    return text.includes('任务名称') || text.includes('总评数') || text.includes('已评数');
  });
  return hasTaskHeaders;
}

function isChildListPage() {
  const doc = getPageDocument();
  // 二级具体课程列表页包含“教师姓名”、“课程代码”或“课程名称”等可见列头
  const hasCourseHeaders = Array.from(doc.querySelectorAll('th')).some(th => {
    if (!isElementVisible(th)) return false;
    const text = th.textContent.trim();
    return text.includes('教师姓名') || text.includes('课程代码') || text.includes('课程名称');
  });
  return hasCourseHeaders;
}

function isAnswerPage() {
  const doc = getPageDocument();
  const hasSliders = doc.querySelector('.ivu-slider') !== null;
  const hasRadioGroups = doc.querySelector('.ivu-radio-group') !== null;
  
  // 必须是当前屏幕可见的滑动条或单选组，防止 SPA 框架隐藏缓存干扰
  let visibleForm = false;
  if (hasSliders) {
    visibleForm = isElementVisible(doc.querySelector('.ivu-slider'));
  }
  if (!visibleForm && hasRadioGroups) {
    visibleForm = isElementVisible(doc.querySelector('.ivu-radio-group'));
  }
  return visibleForm;
}

/**
 * 评教页面 (学生答题页) 的自动化执行流
 */
async function handleAnswerPage() {
  console.log("[AutoEval] 进入评教表单填写流程...");
  await sleep(CONFIG.pageLoadDelay);

  // 1. 处理选择题 (Radio)
  processRadioButtons();
  keepAlive();
  await sleep(CONFIG.delay);

  // 2. 处理滑动条 (Slider)
  processSliders();
  keepAlive();
  await sleep(CONFIG.delay);

  // 3. 处理主观题 (Textarea)
  processTextareas();
  keepAlive();
  await sleep(CONFIG.delay);

  // 4. 提交表单
  await submitAndConfirm();
}

/**
 * 二级列表页面 (具体课程选择页) 的自动化执行流
 */
async function handleListPage() {
  console.log("[AutoEval] 进入二级课程列表页，正在寻找可评教课程...");
  await sleep(CONFIG.pageLoadDelay);
  const doc = getPageDocument();

  // 精准寻找表格内的 "去评价" 按钮，且排除已评价行与页面上无关的标题文字
  const evalBtn = (() => {
    const btns = Array.from(doc.querySelectorAll('button, a, .ivu-btn'));
    for (const btn of btns) {
      if (!isElementVisible(btn)) continue;
      const text = btn.textContent.trim();
      if (text === '去评价') {
        const row = btn.closest('tr');
        if (row && isElementVisible(row)) {
          // 确认这行课程状态不是“已评价”
          if (!row.textContent.includes('已评价')) {
            if (!btn.disabled && !btn.classList.contains('ivu-btn-disabled')) {
              return btn;
            }
          }
        }
      }
    }
    return null;
  })();

  if (evalBtn) {
    console.log("[AutoEval] 找到待评教课程按钮，点击进入...");
    evalBtn.click();
    keepAlive();
  } else {
    // 当前类别的所有课程已评教完成，点击“返回”按钮回到一级分类列表
    console.log("[AutoEval] 当前类别的课程均已评完，尝试返回上一级类别列表...");
    backAttempts++;
    
    const win = getPageWindow();
    let navigated = false;
    
    if (backAttempts === 1) {
      // 第一次尝试：优先调用页面原生 Vue 实例上的 returnLastPage 方法
      if (win.myVue && typeof win.myVue.returnLastPage === 'function') {
        try {
          console.log("[AutoEval] 第一次尝试：直接调用 myVue.returnLastPage()...");
          win.myVue.returnLastPage();
          navigated = true;
        } catch (e) {
          console.error("[AutoEval] 调用 myVue.returnLastPage 失败:", e);
        }
      }
      
      // 兜底 1：点击物理返回按钮
      if (!navigated) {
        const backBtn = findBackButton();
        if (backBtn) {
          console.log("[AutoEval] 第一次尝试：未找到或调用 Vue 方法失败，点击返回按钮...");
          backBtn.click();
          navigated = true;
        }
      }
    } else if (backAttempts === 2) {
      // 第二次尝试：派发完整的 MouseEvent 模拟点击返回按钮
      const backBtn = findBackButton();
      if (backBtn) {
        console.log("[AutoEval] 第二次尝试：模拟完整 MouseEvent 点击返回按钮...");
        try {
          const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win });
          const mouseup = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win });
          const click = new MouseEvent('click', { bubbles: true, cancelable: true, view: win });
          backBtn.dispatchEvent(mousedown);
          backBtn.dispatchEvent(mouseup);
          backBtn.dispatchEvent(click);
          navigated = true;
        } catch (e) {
          console.error("[AutoEval] 模拟派发 MouseEvent 失败:", e);
          backBtn.click();
          navigated = true;
        }
      }
    } else {
      // 第三次及以后尝试：强制改变 Location 进行硬重定向兜底
      try {
        const baseUrl = win.baseUrl || '/jwxt/mk/evaluation/';
        const targetUrl = baseUrl + "studentAssess/studentEvaluationTaskPage";
        console.log("[AutoEval] 第三次及后续尝试：强制修改 URL 重定向到一级列表页 ->", targetUrl);
        win.location.href = targetUrl;
        navigated = true;
      } catch (e) {
        console.error("[AutoEval] 强制重定向失败:", e);
      }
    }
    
    // 如果没有任何方法可以发起返回操作，直接结束
    if (!navigated && backAttempts > 3) {
      console.log("[AutoEval] 尝试多次均无法返回，且无法重定向，直接结束。");
      setShareData(STATE_KEY, 'completed');
    }
  }
}

/**
 * 一级列表页面 (任务分类页) 的自动化执行流
 */
async function handleParentListPage() {
  console.log("[AutoEval] 进入一级任务列表页，正在寻找未完成的评教类别...");
  await sleep(CONFIG.pageLoadDelay);
  const doc = getPageDocument();

  // 动态获取“总评数”和“已评数”的列索引，防止表格列发生变动
  let totalIndex = 5;
  let completedIndex = 6;
  
  const headers = Array.from(doc.querySelectorAll('th')).map(th => th.textContent.trim());
  const foundTotalIdx = headers.findIndex(h => h.includes('总评') || h.includes('总数'));
  const foundCompletedIdx = headers.findIndex(h => h.includes('已评') || h.includes('已完成'));
  
  if (foundTotalIdx !== -1) totalIndex = foundTotalIdx;
  if (foundCompletedIdx !== -1) completedIndex = foundCompletedIdx;

  // 解析表格，对比已评数与总评数，寻找未完成的行
  const evalBtn = (() => {
    const rows = Array.from(doc.querySelectorAll('tr'));
    for (const row of rows) {
      if (!isElementVisible(row)) continue;
      const tds = row.querySelectorAll('td');
      const minLength = Math.max(totalIndex, completedIndex) + 1;
      if (tds.length >= minLength) {
        const total = parseInt(tds[totalIndex].textContent.trim(), 10);
        const completed = parseInt(tds[completedIndex].textContent.trim(), 10);
        if (!isNaN(total) && !isNaN(completed) && completed < total) {
          const btn = row.querySelector('button, a, .ivu-btn');
          if (btn && isElementVisible(btn) && !btn.disabled && !btn.classList.contains('ivu-btn-disabled')) {
            const text = btn.textContent.trim();
            if (text === '去评价') {
              return btn;
            }
          }
        }
      }
    }
    return null;
  })();

  if (evalBtn) {
    console.log("[AutoEval] 找到未完成类别，正在点击进入中...");
    evalBtn.click();
    keepAlive();
  } else {
    console.log("[AutoEval] 所有评教任务全部完成！");
    setShareData(STATE_KEY, 'completed');
  }
}

/**
 * iframe 执行主入口（轮询检测）
 */
let iframeLogicExecuted = false;
let lastActionTime = 0;
const ACTION_COOLDOWN = 3000; // 动作冷却，单位毫秒。防止 SPA 框架因 DOM 刷新不及时产生多次重复点击

async function runIframeLogic() {
  if (iframeLogicExecuted) return;

  // 判断冷却时间
  const now = Date.now();
  if (now - lastActionTime < ACTION_COOLDOWN) return;

  const state = getShareData(STATE_KEY);
  if (state !== 'running') return;

  iframeLogicExecuted = true;

  if (isAnswerPage()) {
    lastActionTime = Date.now();
    await handleAnswerPage();
  } else if (isParentListPage()) {
    lastActionTime = Date.now();
    await handleParentListPage();
  } else if (isChildListPage()) {
    lastActionTime = Date.now();
    await handleListPage();
  }

  iframeLogicExecuted = false;
}

/**
 * 创建主窗口悬浮窗 UI
 */
function createFloatingPanel() {
  const doc = getPageDocument();
  const win = getPageWindow();

  const old = doc.getElementById('auto-eval-panel');
  if (old) old.remove();

  const panel = doc.createElement('div');
  panel.id = 'auto-eval-panel';
  panel.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      background: #fff;
      border: 2px solid #1a7f5a;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      padding: 16px 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-width: 200px;
      user-select: none;
    ">
      <div id="eval-drag-handle" style="
        font-size: 16px;
        font-weight: bold;
        color: #1a7f5a;
        margin-bottom: 12px;
        text-align: center;
        cursor: move;
      ">🎓 自动评教</div>
      <div id="eval-status" style="
        font-size: 13px;
        color: #666;
        margin-bottom: 12px;
        text-align: center;
      ">等待开始...</div>
      <button id="eval-start-btn" style="
        width: 100%;
        padding: 10px 0;
        background: #1a7f5a;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 15px;
        font-weight: bold;
        cursor: pointer;
        transition: background 0.2s;
      ">开始评教</button>
      <button id="eval-minimize-btn" style="
        position: absolute;
        top: 8px;
        right: 10px;
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        color: #999;
      ">−</button>
    </div>
  `;

  doc.body.appendChild(panel);

  const startBtn = doc.getElementById('eval-start-btn');
  const statusEl = doc.getElementById('eval-status');
  const minimizeBtn = doc.getElementById('eval-minimize-btn');
  const dragHandle = doc.getElementById('eval-drag-handle');
  const inner = panel.firstElementChild;

  // 最小化 / 展开悬浮窗
  let minimized = false;
  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    minimized = !minimized;
    const children = inner.children;
    for (let i = 0; i < children.length; i++) {
      if (children[i] !== minimizeBtn && children[i] !== dragHandle) {
        children[i].style.display = minimized ? 'none' : '';
      }
    }
    minimizeBtn.textContent = minimized ? '+' : '−';
  });

  // 拖动功能
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  dragHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    const rect = inner.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
  });

  doc.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    inner.style.left = (startLeft + dx) + 'px';
    inner.style.top = (startTop + dy) + 'px';
    inner.style.right = 'auto';
  });

  doc.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // 绑定主控制按钮事件
  startBtn.addEventListener('click', () => {
    const currentState = getShareData(STATE_KEY);
    if (currentState === 'running') {
      setShareData(STATE_KEY, 'idle');
      updateUI('idle');
    } else {
      const confirmed = confirm('请确保已切换到评教首页（任务分类列表页）！\n\n点击"确定"开始自动评教。');
      if (confirmed) {
        setShareData(STATE_KEY, 'running');
        setShareData(COMPLETED_COUNT_KEY, '0');
        keepAlive();
        updateUI('running');
      }
    }
  });

  // 根据当前状态更新 UI 显示
  function updateUI(state) {
    if (state === 'running') {
      startBtn.textContent = '停止评教';
      startBtn.style.background = '#d93025';
      const count = getShareData(COMPLETED_COUNT_KEY) || '0';
      statusEl.textContent = `自动评教进行中... (已完成: ${count})`;
      statusEl.style.color = '#1a7f5a';
    } else if (state === 'completed') {
      startBtn.textContent = '开始评教';
      startBtn.style.background = '#1a7f5a';
      const count = getShareData(COMPLETED_COUNT_KEY) || '0';
      statusEl.textContent = `评教已完成！共 ${count} 门。`;
      statusEl.style.color = '#1a7f5a';
    } else {
      startBtn.textContent = '开始评教';
      startBtn.style.background = '#1a7f5a';
      statusEl.textContent = '等待开始...';
      statusEl.style.color = '#666';
    }
  }

  // 轮询监听 共享存储 状态变化以更新主悬浮窗
  setInterval(() => {
    const state = getShareData(STATE_KEY);
    updateUI(state);

    if (state === 'completed') {
      const count = getShareData(COMPLETED_COUNT_KEY) || '0';
      setShareData(STATE_KEY, 'idle');
      if (typeof sweetAlert !== 'undefined') {
        sweetAlert(`评教已完成！\n共完成 ${count} 门课程的自动评教。`, { icon: 'success' });
      } else {
        alert(`评教已完成！\n共完成 ${count} 门课程的自动评教。`);
      }
      return;
    }

    // 检查超时限制
    if (state === 'running') {
      const lastAction = parseInt(getShareData(LAST_ACTION_TIME_KEY) || '0', 10);
      if (lastAction > 0 && Date.now() - lastAction > CONFIG.timeoutLimit) {
        // 超时直接停止脚本并提示用户，避免无限空转
        setShareData(STATE_KEY, 'idle');
        updateUI('idle');
        if (typeof sweetAlert !== 'undefined') {
          sweetAlert("自动评教已自动停止。\n原因：脚本检测到评教逻辑未响应超过 30 秒（可能已全部评完，或网页加载超时）。", { icon: "warning" });
        } else {
          alert("自动评教已自动停止。原因：脚本检测到评教逻辑未响应超过 30 秒。");
        }
      }
    }
  }, CONFIG.checkInterval);

  updateUI(getShareData(STATE_KEY));
}

// 统一入口点
(function() {
  const win = getPageWindow();
  if (win.self === win.top) {
    // 顶级窗口：负责创建悬浮窗控制面板，不执行填表
    const doc = getPageDocument();
    if (!doc.documentElement.dataset.autoEvalLoaded) {
      doc.documentElement.dataset.autoEvalLoaded = 'true';
      createFloatingPanel();
    }
  } else {
    // 子 iframe：轮询执行自动评教
    setInterval(runIframeLogic, CONFIG.checkInterval);
  }
})();
