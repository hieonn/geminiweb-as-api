const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { program } = require('commander');
const AdmZip = require('adm-zip'); // 💡 ESM 모듈 꼬임이 절대 없는 순수 라이브러리 대체

program
  .option('-p, --profile <type>', '크롬 프로필 폴더명 (Default, Profile 1 등)', 'Default')
  .option('-s, --session <type>', '지정할 모델/세션 이름', 'gemini-model')
  .option('-u, --url <type>', '서버 API 타겟 주소', 'http://localhost:3030');

program.parse(process.argv);
const options = program.opts();

async function run() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  let chromeUserDir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data')
    : (process.platform === 'darwin' ? path.join(homeDir, 'Library/Application Support/Google/Chrome') : path.join(homeDir, '.config/google-chrome'));

  const sourceProfilePath = path.join(chromeUserDir, options.profile);
  if (!(await fs.pathExists(sourceProfilePath))) { 
    console.error(`❌ 크롬 프로필 경로가 존재하지 않습니다: ${sourceProfilePath}`); 
    process.exit(1); 
  }

  const zipPath = path.join(__dirname, 'temp_profile.zip');
  console.log(`📦 무거운 캐시 폴더 제외 스마트 압축 진행 중...`);

  try {
    const zip = new AdmZip();

    // 뚱뚱한 캐시 디렉토리들을 필터링하며 압축 파일에 추가
    const files = await fs.readdir(sourceProfilePath);
    const ignoreList = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker'];

    for (const file of files) {
      if (ignoreList.some(ignoreKey => file.includes(ignoreKey))) {
        continue; // 캐시 관련 폴더는 과감히 스킵
      }

      const fullPath = path.join(sourceProfilePath, file);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        zip.addLocalFolder(fullPath, file);
      } else {
        zip.addLocalFile(fullPath);
      }
    }

    // 압축 파일 물리적 생성
    zip.writeZip(zipPath);
    console.log(`✅ 스마트 압축 완료! 용량을 최적화했습니다.`);

    console.log(`🚀 원격 서버로 전송 주입 중... (대용량 스트림 모드)`);
    const form = new FormData();
    form.append('env', 'remote');
    form.append('profileName', options.session);
    form.append('profileZip', fs.createReadStream(zipPath));

    // 💡 EPIPE 방지를 위해 타임아웃 제한을 10분으로 해제하고 Keep-Alive 유지
    const response = await axios.post(`${options.url}/api/init`, form, { 
      headers: {
        ...form.getHeaders(),
        'Connection': 'keep-alive'
      },
      maxContentLength: Infinity, 
      maxBodyLength: Infinity,
      timeout: 600000 
    });
    
    console.log(`🎉 주입 완료:`, response.data.message);

  } catch (error) { 
    console.error(`❌ 전송 실패:`, error.message); 
  } finally { 
    if (await fs.pathExists(zipPath)) {
      await fs.remove(zipPath); 
    }
  }
}

run();