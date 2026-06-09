#!/bin/bash
if [ "$EUID" -ne 0 ]; then
  echo "❌ 이 스크립트는 sudo 권한으로 실행해야 합니다: sudo $0"
  exit 1
fi

echo "===================================================="
echo " 🟢 [프로젝트 1] Gemini LLM API 서버 인프라 셋업 마법사"
echo "===================================================="

echo "📦 1단계: 독립형 Docker 컨테이너 가동..."
docker compose down
docker compose up -d --build

echo "🔍 2단계: 서버 내 Nginx 인프라 환경 조사 중..."
if which nginx > /dev/null 2>&1; then
    HAS_NGINX=true
    echo "💡 결과: 외부 Nginx 발견. 프록시 규칙을 연동합니다."
else
    HAS_NGINX=false
    echo "💡 결과: Nginx 없음. 독립 실행 방화벽 모드를 전개합니다."
fi

if [ "$HAS_NGINX" = true ]; then
    echo "🔍 활성화된 모든 Nginx 가상 호스트 환경을 조사합니다..."
    
    # 1. 주입할 프록시 설정 템플릿 생성 (임시 파일)
    cat << 'EOF' > /tmp/gemini_location.conf

    # --- Gemini LLM API Proxy Start ---
    client_max_body_size 2G;

    location /v1/ {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 600;
        proxy_send_timeout 600;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 600;
        proxy_send_timeout 600;
    }
    # --- Gemini LLM API Proxy End ---
EOF

    # 2. 현재 활성화된 Nginx 설정 디렉토리 내의 모든 파일 전수조사
    # 심볼릭 링크가 걸려있는 실제 활성화된 파일들만 타겟으로 잡습니다.
    ENABLED_DIR="/etc/nginx/sites-enabled"
    MATCH_FOUND=false

    if [ -d "$ENABLED_DIR" ] && [ "$(ls -A $ENABLED_DIR)" ]; then
        for CONF_FILE in "$ENABLED_DIR"/*; do
            # 파일이 존재하고 일반 파일(또는 링크)인 경우에만 진행
            if [ -f "$CONF_FILE" ]; then
                # 이미 우리가 작업한 특수 문자(플래그)가 있는지 선제 검사
                if grep -q "Gemini LLM API Proxy" "$CONF_FILE"; then
                    echo "💡 [스킵] $CONF_FILE 에는 이미 Gemini 프록시 설정이 적용되어 있습니다."
                    MATCH_FOUND=true
                    continue
                fi

                # 해당 파일이 'listen 80' 구조를 가지고 있는지 엄격하게 검사
                # 주석 처리된 listen 80(# listen 80)은 제외하도록 정규식 필터링
                if grep -E "^\s*listen\s+80" "$CONF_FILE" > /dev/null 2>&1; then
                    echo "🎯 [적용 대상 발견] 80포트를 사용하는 설정을 찾았습니다: $CONF_FILE"
                    
                    # 'server {' 가 열리는 시점 바로 뒤에 프록시 블록 끼워 넣기
                    sed -i '/server {/r /tmp/gemini_location.conf' "$CONF_FILE"
                    echo "✅ $CONF_FILE 내부에 라우팅 규칙 주입 성공!"
                    MATCH_FOUND=true
                fi
            fi
        done
    fi

    # 3. 만약 sites-enabled 환경이 아니거나 활성화된 80포트 설정 파일을 못 찾은 경우 방어선
# 3. 🎯 방어선: 활성화된 80포트 가상 호스트를 단 하나도 찾지 못한 경우 (클린 서버)
    if [ "$MATCH_FOUND" = false ]; then
        FALLBACK_CONF="/etc/nginx/sites-available/gemini-fallback-api"
        FALLBACK_ENABLED="/etc/nginx/sites-enabled/gemini-fallback-api"

        echo "⚠️ 활성화된 개별 80포트 설정을 찾지 못했습니다."
        echo "⚙️ 독립형 Gemini API 전용 가상 호스트를 개설합니다: $FALLBACK_CONF"

        # 💡 [개선] 뼈대만 만들고, 내부 location 규칙은 상단의 임시 파일을 그대로 재사용하여 병합합니다.
        cat << 'EOF' > $FALLBACK_CONF
server {
    listen 80 default_server;
    server_name _;
EOF

        # 이미 검증된 임시 파일(/tmp/gemini_location.conf) 내용을 그대로 이어 붙이기
        cat /tmp/gemini_location.conf >> $FALLBACK_CONF

        # server 블록 닫아주기
        echo "}" >> $FALLBACK_CONF

        # 활성화 폴더로 심볼릭 링크 생성
        ln -sf $FALLBACK_CONF $FALLBACK_ENABLED
        echo "✅ 독립형 80포트 가상 호스트 생성 및 활성화 완료 (임시 파일 구조 재사용)."
    fi

    # 임시 파일 정리
    rm -f /tmp/gemini_location.conf

    # 4. Nginx 전체 문법 검증 및 리로드
    echo "⚡ Nginx 환경 설정을 검증하고 서버를 재시작합니다..."
    if nginx -t; then
        systemctl restart nginx
        echo "🎯 Nginx 인프라 연동이 완벽하게 성공했습니다! 이제 포트 충돌 없이 외부 80포트로 API 호출이 가능합니다."
    else
        echo "❌ Nginx 설정 검증 실패! 기존 상태로 롤백을 권장하거나 수동 점검이 필요합니다."
    fi
else
    if which ufw > /dev/null 2>&1; then
        ufw allow 3030/tcp && ufw reload
    fi
    echo "🎯 독립형 모드 완성! 외부 포트 3030(http://[서버-IP]:3030)으로 통신 가능합니다."
fi