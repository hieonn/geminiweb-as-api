#!/bin/bash
if [ "$EUID" -ne 0 ]; then
  echo "❌ 이 스크립트는 sudo 권한으로 실행해야 합니다: sudo $0"
  exit 1
fi

echo "===================================================="
echo " 🟢 [프로젝트 1] Gemini LLM API 서버 인프라 셋업 마법사"
echo "===================================================="

echo "📦 1단계: 독립형 Docker 컨테이너 가동..."
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
    read -p " Nginx 도메인 혹은 서버 IP를 입력하세요 (기본값: localhost): " DOMAIN_NAME
    if [ -z "$DOMAIN_NAME" ]; then DOMAIN_NAME="localhost"; fi

    NGINX_CONF="/etc/nginx/sites-available/gemini-llm-api"
    NGINX_ENABLED="/etc/nginx/sites-enabled/gemini-llm-api"
    
    cat << EOF > $NGINX_CONF
server {
    listen 80;
    server_name $DOMAIN_NAME;
    client_max_body_size 150M; # 대용량 프로필 압축 패키지 전송 허용

    location / {
        proxy_pass http://127.0.0.1:3030; 
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }
}
EOF
    ln -sf $NGINX_CONF $NGINX_ENABLED
    nginx -t && systemctl restart nginx
    echo "🎯 Nginx 프록시 세팅 완료! 외부 포트 80(http://$DOMAIN_NAME) 주소로 통신 가능합니다."
else
    if which ufw > /dev/null 2>&1; then
        ufw allow 3030/tcp && ufw reload
    fi
    echo "🎯 독립형 모드 완성! 외부 포트 3030(http://[서버-IP]:3030)으로 통신 가능합니다."
fi