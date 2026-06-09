const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const decompress = require('decompress');

const app = express();
app.use(express.json());

// 💡 메모리 버퍼 폭발 및 EPIPE 방지를 위한 디스크 스토리지 엔진 설정
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.ensureDirSync(path.join(__dirname, 'uploads'));
    cb(null, path.join(__dirname, 'uploads/'));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 250 * 1024 * 1024 } // 최대 250MB 수용
});

const DATA_FILE = path.join(__dirname, 'sessions.json');

let globalBrowser = null;
let currentTab = { sessionName: null, page: null };

async function readSessions() {
  if (!(await fs.pathExists(DATA_FILE))) return {};
  try {
    return await fs.readJson(DATA_FILE);
  } catch (e) {
    // 만약 파일이 깨졌거나 폴더 형태면 리셋 후 빈 객체 반환
    return {};
  }
}

async function saveSessions(data) {
  await fs.writeJson(DATA_FILE, data, { spaces: 2 });
}

// 💡 안전한 다중 입력창/전송 버튼 셀렉터 팩터링 유틸
const INPUT_SELECTORS = [
  'textarea[placeholder*="Gemini"]',
  'textarea[placeholder*="제미니"]',
  'div[contenteditable="true"][aria-label*="Gemini"]',
  'div[contenteditable="true"][aria-label*="제미니"]',
  '#input-area textarea',
  '[role="textbox"]'
];

const SEND_SELECTORS = [
  'button[aria-label*="전송"]',
  'button[aria-label*="Send"]',
  'button.send-button',
  'button[disabled="false"]'
];

// 스마트 타이핑 & 전송 캡슐화 함수
// 스마트 타이핑 & 전송 캡슐화 함수 (개행 문자 오작동 방지 완제품 버전)
async function typeAndSend(page, text) {
  let inputSelector = null;
  for (const selector of INPUT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 3000 });
      inputSelector = selector;
      break;
    } catch (e) {}
  }

  if (!inputSelector) {
    const debugPath = path.join(__dirname, 'uploads', `debug-selector-failed-${Date.now()}.png`);
    await page.screenshot({ path: debugPath }).catch(() => {});
    throw new Error(`[UI 에러] 제미니 입력창을 찾을 수 없습니다. 로그인이 풀렸거나 화면 구조가 변경되었습니다. 스크린샷 저장됨: ${debugPath}`);
  }

  // 1. 입력창 클릭하여 포커스 주기
  await page.click(inputSelector);

  // 2. [핵심 수정] page.type 대신 브라우저 컨텍스트 내에서 value를 통째로 주입
  // 이렇게 하면 \n이 있더라도 엔터가 처박히지 않고 텍스트 그대로 입력창에 안착합니다.
  await page.evaluate((sel, content) => {
    const el = document.querySelector(sel);
    if (el) {
      // contenteditable 속성인 엘리먼트와 일반 textarea 둘 다 방어하기 위한 로직
      if (el.tagName === 'DIV' || el.getAttribute('contenteditable') === 'true') {
        el.innerText = content;
      } else {
        el.value = content;
      }
      
      // 중요: 값이 변경되었음을 리액트/웹 페이지 엔진에 강제로 알림 (이벤트 트리거)
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, inputSelector, text);

  // 3. 잠시 브라우저가 이벤트를 소화할 수 있도록 미세한 딜레이 (안전장치)
  await new Promise(resolve => setTimeout(resolve, 500));

  // 4. 전송 버튼 클릭 루프 진행
  let sendButtonFound = false;
  for (const selector of SEND_SELECTORS) {
    try {
      // 버튼이 클릭 가능한 상태인지 확인 후 클릭
      await page.waitForSelector(selector, { visible: true, timeout: 2000 });
      await page.click(selector);
      sendButtonFound = true;
      break;
    } catch (e) {}
  }

  // 5. 만약 전송 버튼 매칭이 실패했다면 최종적으로 엔터 키 시그널 발송
  if (!sendButtonFound) {
    console.log("⚠️ 전송 버튼을 찾지 못해 키보드 엔터로 전송을 시도합니다.");
    await page.keyboard.press('Enter');
  }
}

// [API 1] 클라이언트 크롬 세션 프로필 주입 수신
app.post('/api/init', upload.single('profileZip'), async (req, res) => {
  const { env, profileName } = req.body;
  const profileZip = req.file;

  if (!profileZip) {
    return res.status(400).json({ error: "profileZip 파일이 전송되지 않았습니다." });
  }

  try {
    if (globalBrowser) {
      await globalBrowser.close().catch(() => {});
    }

    const currentEnv = env || 'remote';
    let targetUserDataDir = path.join(__dirname, 'remote-profiles', profileName || 'Default');

    if (currentEnv === 'remote') {
      await fs.emptyDir(targetUserDataDir);
      console.log(`📦 [서버] 압축 해제 시작: ${profileZip.path} -> ${targetUserDataDir}`);
      await decompress(profileZip.path, targetUserDataDir);
      await fs.remove(profileZip.path).catch(() => {});
    }

    // 설치된 환경에 맞춰 가변 경로 지정 
    const chromePath = fs.existsSync('/usr/bin/google-chrome') 
      ? '/usr/bin/google-chrome' 
      : '/usr/bin/google-chrome-stable';

    globalBrowser = await puppeteer.launch({
      headless: currentEnv === 'remote' ? "new" : false,
      executablePath: currentEnv === 'remote' ? chromePath : undefined,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        `--user-data-dir=${targetUserDataDir}`,
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    res.json({ success: true, message: `[${profileName}] 세션 크롬 엔진 초기화 성공.` });
  } catch (error) {
    console.error("❌ 초기화 내부 에러:", error);
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});


// [API 2] 표준 OpenAI 규격 호환 대화 라우트
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages } = req.body;
  if (!messages || messages.length === 0) return res.status(400).json({ error: "messages가 없습니다." });

  const sessionName = model || "default-session";
  const lastMessage = messages[messages.length - 1];
  const prompt = lastMessage.content; 

  try {
    const sessions = await readSessions();
    const formattedHistory = [];
    
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
      formattedHistory.push({ role, content: msg.content });
    }
    sessions[sessionName] = formattedHistory;
    await saveSessions(sessions);

    if (currentTab.page && currentTab.sessionName !== sessionName) {
      await currentTab.page.close().catch(() => {});
      currentTab.page = null;
      currentTab.sessionName = null;
    }

    if (!currentTab.page) {
      if (!globalBrowser) {
        throw new Error("크롬 브라우저가 기동되지 않았습니다. /api/init을 먼저 호출하세요.");
      }
      currentTab.page = await globalBrowser.newPage();
      currentTab.sessionName = sessionName;
      
      // 창 크기를 넉넉하게 세팅하여 모바일 UI 변형 방지
      await currentTab.page.setViewport({ width: 1280, height: 800 });
      await currentTab.page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2' });

      // 과거 맥락 동기화 주입
      if (formattedHistory.length > 0) {
        let contextPrompt = "[이전 대화 복구] 아래 기록을 인지하고 대기하세요.\n\n";
        formattedHistory.forEach(msg => { contextPrompt += `${msg.role === 'user' ? 'User' : 'Gemini'}: ${msg.content}\n`; });
        contextPrompt += "\n[인지 완료] 다음 메시지가 오면 이어서 답변하세요.";
        
        await typeAndSend(currentTab.page, contextPrompt);
        await waitForGeminiReply(currentTab.page);
      }
    }

    const page = currentTab.page;
    // 최종 메인 질문 전송
    await typeAndSend(page, prompt);
    
    const replyText = await waitForGeminiReply(page);

    sessions[sessionName].push({ role: "user", content: prompt });
    sessions[sessionName].push({ role: "model", content: replyText });
    await saveSessions(sessions);

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: sessionName,
      choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  } catch (error) {
    console.error("❌ 대화 처리 중 에러:", error);
    res.status(500).json({ error: { message: error.message } });
  }
});


// 정밀 답변 파싱 유틸리티
async function waitForGeminiReply(page) {
  console.log("⏳ [서버] 제미니 응답 생성 대기 중...");
  
  // 1. 제미니가 답변을 작성 중일 때 뜨는 '중지/Stop' 버튼이 사라질 때까지 대기 (출력 완료 시점 탐지)
  try {
    await page.waitForSelector('button[aria-label*="중지"], button[aria-label*="Stop"], button[smooth-entry]', { visible: true, timeout: 4000 });
    await page.waitForSelector('button[aria-label*="중지"], button[aria-label*="Stop"], button[smooth-entry]', { hidden: true, timeout: 60000 });
  } catch (e) {
    // 중지 버튼이 너무 빨리 지나갔거나 구조가 다르면 안전하게 5초간 딜레이 대기
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // 2. 답변 생성이 끝나면 나타나는 하단 액션 버튼(복사/좋아요 등) 대기
  try {
    await page.waitForSelector('button[aria-label*="복사"], button[aria-label*="Copy"], [class*="action-buffer"], message-actions', { visible: true, timeout: 15000 });
  } catch (e) {
    console.log("⚠️ 복사 버튼 탐지 지연, 계속 파싱 시도합니다.");
  }

  // 3. 제미니가 출력한 진짜 '답변 텍스트 본문'을 긁어오기 위한 다중 셀렉터 매핑
  const replySelectors = [
    'message-content',                    // 💡 최신 제미ni 컴포넌트 핵심 태그
    '.message-content',
    'div[aria-label*="답변"]',
    'div[role="message"]',
    '.model-response',
    '.reply-content-body'
  ];

  let replies = [];
  for (const selector of replySelectors) {
    replies = await page.$$(selector);
    if (replies.length > 0) {
      console.log(`🎯 매칭된 답변 셀렉터 파싱 성공: ${selector} (개수: ${replies.length})`);
      break;
    }
  }

  // 4. 안전장치: 만약 위의 셀렉터로도 잡히지 않는다면 브라우저 내 마크다운 렌더링 본문을 직접 추적
  if (replies.length === 0) {
    replies = await page.$$('.query-content'); 
  }

  // 5. 가장 마지막(최신) 답변 블록 지정
  if (!replies || replies.length === 0) {
    throw new Error("[파싱 에러] 제미니가 답변은 했으나, 화면에서 답변 텍스트 영역을 긁어오지 못했습니다. 구조 업데이트가 필요합니다.");
  }

  const lastReplyElement = replies[replies.length - 1];
  
  // innerText 읽기 전에 엘리먼트 존재 여부 다시 한 번 철저하게 검증하여 undefined 방어
  if (!lastReplyElement) {
    throw new Error("[파싱 에러] 유효한 마지막 답변 엘리먼트를 특정할 수 없습니다.");
  }

  const resultText = await page.evaluate(el => el ? el.innerText.trim() : '', lastReplyElement);
  console.log(`✅ [서버] 답변 수신 완료 (길이: ${resultText.length}자)`);
  return resultText;
}

const server = app.listen(3030, () => console.log(`🚀 Gemini API Server running on port 3030`));
server.keepAliveTimeout = 600000;
server.headersTimeout = 605000;