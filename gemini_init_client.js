const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { program } = require('commander');
const AdmZip = require('adm-zip');
const inquirer = require('inquirer'); // 💡 터미널 대화형 선택창 라이브러리

program
  .requiredOption('-s, --session <type>', '지정할 모델/세션 이름')
  .requiredOption('-u, --url <type>', '서버 API 타겟 주소 (예: http://localhost:3030)');

program.parse(process.argv);
const options = program.opts();

// 💡 구글 로그인이 된 프로필들을 완전 전수조사하여 배열로 반환
async function findGoogleProfiles(chromeUserDir) {
  const googleProfiles = [];
  if (!(await fs.pathExists(chromeUserDir))) return googleProfiles;

  const dirs = await fs.readdir(chromeUserDir);
  
  for (const dir of dirs) {
    // Default 폴더 및 Profile 1, Profile 2 등 모든 프로필 디렉터리 대상
    if (dir === 'Default' || dir.startsWith('Profile ')) {
      const prefPath = path.join(chromeUserDir, dir, 'Preferences');
      
      if (await fs.pathExists(prefPath)) {
        try {
          const prefData = await fs.readJson(prefPath);
          
          // 크롬 계정 정보 저장 경로 라우팅 스캔
          const lastUsername = prefData.services?.last_username;
          const accountInfo = prefData.account_info || prefData.google?.services?.account_info;
          
          let email = lastUsername || '';
          if (!email && accountInfo) {
            if (Array.isArray(accountInfo) && accountInfo.length > 0) {
              email = accountInfo[0].email;
            } else if (typeof accountInfo === 'object') {
              const firstKey = Object.keys(accountInfo)[0];
              email = accountInfo[firstKey]?.email || '';
            }
          }

          // 구글 로그인 이메일 형식을 갖추고 있다면 후보군에 추가
          if (email && email.includes('@')) {
            googleProfiles.push({
              name: `👤 계정: ${email} (실제 폴더: ${dir})`, // 사용자가 볼 화면 표시명
              value: dir // 내부적으로 사용할 실제 폴더명
            });
          }
        } catch (err) {
          continue; 
        }
      }
    }
  }
  return googleProfiles;
}

async function run() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  let chromeUserDir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data')
    : (process.platform === 'darwin' ? path.join(homeDir, 'Library/Application Support/Google/Chrome') : path.join(homeDir, '.config/google-chrome'));

  console.log(`🔍 시스템 내 구글 연동 크롬 프로필을 조회하고 있습니다...`);
  const googleProfiles = await findGoogleProfiles(chromeUserDir);
  
  let targetProfile = '';

  if (googleProfiles.length === 0) {
    console.log(`⚠️ 구글 연동 세션이 탐색되지 않았습니다. 기본 [Default] 폴더 사용을 시도합니다.`);
    targetProfile = 'Default';
  } else {
    // 💡 인터랙티브 선택창 UI 제공
    console.log('\n==================================================');
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedProfile',
        message: '🚀 전송(주입)할 구글 로그인 프로필을 선택해 주세요:',
        choices: googleProfiles
      }
    ]);
    console.log('==================================================\n');
    targetProfile = answer.selectedProfile;
  }

  const sourceProfilePath = path.join(chromeUserDir, targetProfile);
  if (!(await fs.pathExists(sourceProfilePath))) { 
    console.error(`❌ 크롬 프로필 경로가 존재하지 않습니다: ${sourceProfilePath}`); 
    process.exit(1); 
  }

  console.log(`▶️ 최종 선택된 주입 대상 경로: ${sourceProfilePath}`);

  // ---- [압축 및 전송 로직] ----
  const zipPath = path.join(__dirname, 'temp_profile.zip');
  console.log(`📦 무거운 캐시 및 세션 무관 폴더 제외 스마트 압축 진행 중...`);

  try {
    const zip = new AdmZip();
    const files = await fs.readdir(sourceProfilePath);
    
    // 413 에러 원천 차단을 위해 불필요 용량 폴더 제외 가속화
    const ignoreList = [
      'Cache', 'Code Cache', 'GPUCache', 'Service Worker', 
      'WebStorage', 'IndexedDB', 'File System', 'Crashpad', 'Application Cache'
    ];

    for (const file of files) {
      if (ignoreList.some(ignoreKey => file.includes(ignoreKey))) {
        continue;
      }

      const fullPath = path.join(sourceProfilePath, file);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        zip.addLocalFolder(fullPath, file);
      } else {
        zip.addLocalFile(fullPath);
      }
    }

    zip.writeZip(zipPath);
    console.log(`✅ 스마트 압축 완료!`);

    console.log(`🚀 원격 서버로 전송 주입 중... (대용량 스트림 모드)`);
    const form = new FormData();
    form.append('env', 'remote');
    form.append('profileName', options.session);
    form.append('profileZip', fs.createReadStream(zipPath));

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