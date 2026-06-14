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
  const { model, messages, tools } = req.body;
  
  // 💡 [안전 장치] messages 검증
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: "messages 배열이 비어있습니다." });
  }

  const sessionName = model || "default-session"; // 👈 1. sessionName 선언 복구
  let prompt = messages[messages.length - 1].content; // 파이썬이 보낸 순수 질문

  // 💡 [조건 확인] 최상위 패킷에 tools field가 존재하는지 검사
  const isToolContext = (tools && Array.isArray(tools) && tools.length > 0);

  if (isToolContext) {
    console.log(`🔌 [인프라 작동] 툴 명세 감지됨. 백엔드에서 프롬프트 인젝션을 전개합니다.`);
    
    let injectedInstruction = `\n\n[SYSTEM INSTRUCTION: AVAILABLE TOOLS]\n`;
    injectedInstruction += `You are NOT an assistant. You are a tool router. Your ONLY job is to select tools. You MUST NEVER answer questions or perform calculations.\n`;
    injectedInstruction += `When a tool needs to be called, you MUST respond ONLY with a single JSON object inside a markdown code block.\n\n`;
    injectedInstruction += `Available Tools Specification:\n${JSON.stringify(tools, null, 2)}\n\n`;
    injectedInstruction += `Format for tool calling:\n\`\`\`json\n{\n    "name": "tool_name",\n    "arguments": {\n        "arg_name": "value"\n    }\n}\n\`\`\``;
    injectedInstruction += `Do not write any conversations, explanations, or thoughts.`
    injectedInstruction += `If no tools are required, reply normally in plain text.`

    // 순수 질문 뒤에 시스템 지시문을 결합 (자동 인젝션)
    prompt = prompt + injectedInstruction;
  }

  try {
    // 1. 브라우저 및 탭 초기화 검사
    if (!currentTab.page) {
      if (!globalBrowser) {
        throw new Error("크롬 브라우저가 기동되지 않았습니다. /api/init을 먼저 호출하세요.");
      }
      currentTab.page = await globalBrowser.newPage();
      currentTab.sessionName = sessionName;
      
      await currentTab.page.setViewport({ width: 1280, height: 800 });
      await currentTab.page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2' });
    }

    const page = currentTab.page;

    // 💡 2. [복구] 제미니 입력창에 실제 전송하고 응답을 받아오는 핵심 로직
    console.log("📝 제미니 창에 프롬프트 주입 중...");
    await typeAndSend(page, prompt);
    const replyText = await waitForGeminiReply(page); 

    // 기본 응답 스켈레톤 (일반 대화용)
    let messagePayload = { role: "assistant", content: replyText, tool_calls: null };
    let finishReason = "stop";

    // 💡 [돌려줄 때 처리] 툴 콘텍스트였고 제미니가 JSON을 출력했다면 tool_calls에 정밀 매핑
    if (isToolContext && replyText.includes('{') && replyText.includes('}')) {
      try {
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedJson = JSON.parse(jsonMatch[0]);

          if (parsedJson.name && parsedJson.arguments) {
            console.log(`🎯 [가공 완료] 제미니 JSON 검증 성공 -> tool_calls 구조로 리턴 처리를 진행합니다.`);
            
            // 랭체인 표준 규격에 맞게 content는 비우고, tool_calls에 재배치하여 돌려줍니다.
            messagePayload.content = null; 
            messagePayload.tool_calls = [
              {
                id: `call_${Math.random().toString(36).substr(2, 9)}`,
                type: "function",
                function: {
                  name: parsedJson.name,
                  arguments: typeof parsedJson.arguments === 'string' 
                    ? parsedJson.arguments 
                    : JSON.stringify(parsedJson.arguments)
                }
              }
            ];
            finishReason = "tool_calls"; // 완벽한 종료 사인 세팅
          }
        }
      } catch (e) {
        console.log("⚠️ 제미니 출력물이 JSON 규격과 맞지 않아 일반 대화로 반환합니다.");
      }
    }

    // 2. OpenAI 호환 최종 포맷으로 회신
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, message: messagePayload, finish_reason: finishReason }]
    });

  } catch (error) {
    console.error("❌ 대화 처리 오류:", error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 [디버깅 전용] 클라이언트가 보내는 raw 데이터를 그대로 반사(Mirror)하는 엔드포인트
app.post('/v1/t/echo/chat/completions', (req, res) => {
  console.log("\n=================== 📥 ECHO DEBUG START ===================");
  console.log(`Time: ${new Date().toLocaleString()}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("===========================================================\n");

  // 클라이언트가 보낸 헤더와 바디 구조를 그대로 JSON으로 반환합니다.
  res.json({
    debug_message: "This is an echo response for debugging purposes. The server received your request and is reflecting the data back to you.",
    received_headers: req.headers,
    received_body: req.body,
    
    // 💡 LangChain ChatOpenAI가 파싱 에러를 내며 뻗지 않도록 최소한의 OpenAI 규격도 함께 얹어줍니다.
    id: `chatcmpl-echo-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.body.model || "echo-debug",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `echo :\n\n${JSON.stringify(req.body, null, 2)}`
      },
      finish_reason: "stop"
    }]
  });
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