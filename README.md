# GeminiWeb-As-API 🚀

Transform the Google Gemini Web interface into a **100% OpenAI-compatible API gateway** using your active browser session.
공식 API 키 없이 로컬 브라우저 세션을 이식하여, 구글 제미나이 웹 인터페이스를 **OpenAI 호환 API 게이트웨이**로 변환해 주는 도구입니다.

Just use in your private test use. Don't open to public.
개인적인 테스트 용도로만 쓰세요. 절대로 public에 공개하면 안됩니다. 

---

## Core Requirement 

You must **clone this repository on BOTH your Remote Server and Local Client (PC)**.  
이 프로젝트는 **원격 서버(Remote Server)와 로컬 PC(Client) 양쪽 모두에 clone 해야 합니다.**

---

## 1. Simple Installation Guide

### 1) Remote Server (Run 1 Shell Script)
Clone the repository on your remote Linux server and simply run the initialization shell script with `sudo`.

```text
git clone https://github.com/hieonn/geminiweb-as-api.git
cd geminiweb-as-api

sudo bash gemini_init_server.sh
```

### 2) Local Client PC (Run 1 Node Script)
Clone the repository on your local machine (e.g., MacBook) where Chrome is logged into Gemini, and run the client script to inject your session.

```text
git clone https://github.com/hieonn/geminiweb-as-api.git
cd geminiweb-as-api

npm install
node gemini_init_client.js --session "gemini-web-agent" --url "http://{remote IP}}"
```
You don't need to find Chrome Profile any more, client init will find the profile automatically

## 2. Usage (curl)
Now you can make standard OpenAI-compatible requests to your gateway server:

```text
curl http://{remote server IP}/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web-agent",
    "messages": [
      {"role": "user", "content": "Hello, analyze today weather conditions."}
    ]
  }'
```

### Usage (LangChain, OpenAI compatible)

```
from langchain_openai import ChatOpenAI

# 1. Configure the ChatOpenAI object
llm = ChatOpenAI(
    # Corresponds to the -d '{"model": "gemini-web-agent"}' part in curl
    model="gemini-web-agent", 
    # Set the endpoint address from curl's http://{IP}/v1/chat/completions 
    # (/chat/completions is automatically appended by the library)
    openai_api_base="http://{ip}/v1", 
    # Even if the custom server doesn't require an API key, 
    # it's safer to provide a dummy value to pass internal library validation.
    openai_api_key="dummy-key-if-not-required",
    temperature=0.7
)

# 2. Invoke the model
response = llm.invoke("Are you good at using tools if I provide them to you?")

# 3. Print the result
print(response.content)
```

## 1. 설치 가이드

#### 1) 원격 서버 설정 (쉘 스크립트 1개 실행)  
원격 리눅스 서버에 프로젝트를 먼저 clone 한 뒤, 초기화 스크립트 딱 하나만 실행하면 도커 가동과 Nginx 프록시 설정이 자동으로 완료됩니다.

```text
git clone https://github.com/hieonn/geminiweb-as-api.git
cd geminiweb-as-api

sudo bash gemini_init_server.sh
```

#### 2) 로컬 PC 설정 (노드 스크립트 1개 실행)
구글 제미나이가 로그인되어 있는 내 PC(Mac/Windows)에도 프로젝트를 동일하게 clone 한 뒤, 패키지를 설치하고 주입 스크립트를 실행하여 크롬 인증 세션을 서버로 보냅니다.

```text
git clone https://github.com/hieonn/geminiweb-as-api.git](https://github.com/hieonn/geminiweb-as-api.git)
cd geminiweb-as-api

npm install
node gemini_init_client.js --session "gemini-web-agent" --url "http://{remote server IP}"
```
더이상 프로파일을 찾아서 지정할 필요가 없습니다. init 과정에서 적절한 프로파일을 자동으로 찾아줄 것입니다. 

### 실전 사용법 (curl)
준비가 끝났습니다. 이제 OpenAI 규격 그대로 서버 IP를 향해 질문을 던지면 제미나이의 답변을 받아볼 수 있습니다:

```text
curl http://{remote server IP}/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web-agent",
    "messages": [
      {"role": "user", "content": "안녕하세요, 오늘 날씨에 대해 분석해 주세요."}
    ]
  }'
```

### 실전사용법 (LangChain)

```
from langchain_openai import ChatOpenAI

# 1. ChatOpenAI 객체 설정
llm = ChatOpenAI(
    # curl의 -d '{"model": "gemini-web-agent"}' 부분 대응
    model="gemini-web-agent", 
    # curl의 http://IP/v1/chat/completions 에서 엔드포인트 주소 설정 (/chat/completions는 자동으로 붙습니다)
    openai_api_base="http://{ip}/v1", 
    # 커스텀 서버가 별도의 API Key를 요구하지 않더라도, 라이브러리 내부 검증을 통과하기 위해 dummy 값이라도 넣어주는 것이 안전합니다.
    openai_api_key="dummy-key-if-not-required",
    temperature=0.7
)

# 2. 호출
response = llm.invoke("너는 tool을 잘 쓸 수 있니? 내가 주면?.")

# 3. 결과 확인
print(response.content)
```

### License
Distributed under the MIT License. See LICENSE for more information.
