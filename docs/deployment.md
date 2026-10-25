# 배포

Docker 없이 Ubuntu 서버 한 대에 배포합니다. `main`에 병합되면 GitHub Actions가 검사를 통과한 커밋을 서버에 올리고 서비스를 바꿉니다.

## 서버 구성

```text
브라우저 → Cloudflare → Nginx ─ /api/ → FastAPI (127.0.0.1:8000)
                              └ 나머지 → Next.js (127.0.0.1:3000)
```

| 경로 | 내용 |
| --- | --- |
| `/srv/hwagae/releases/<커밋>` | 배포한 코드. `current` 링크로 사용할 버전을 고릅니다 |
| `/srv/hwagae/shared/hwagae.sqlite3` | DB. 코드와 분리해 보존합니다 |
| `/srv/hwagae/shared/ai-master.key` | 저장한 AI 키를 암호화하는 키. DB와 함께 백업합니다 |
| `/srv/hwagae/shared/models/` | Walmart TFT 체크포인트(선택) |
| `/etc/hwagae/hwagae.env` | 운영 환경 변수 |

두 앱은 systemd 서비스(`ops/hwagae-api.service`, `ops/hwagae-web.service`)로 실행하고, Nginx 설정은 `ops/nginx.cloudflare.conf`에 있습니다. 배포 계정의 sudo는 두 서비스의 restart·stop으로 제한합니다.

운영 환경 변수 예시:

```dotenv
APP_ENV=production
SEED_DEMO=true
DEMO_PASSWORD=<16자 이상, 서버에서 따로 정함>
CORS_ORIGINS=https://<도메인>
```

운영 환경에서 기본 체험 비밀번호를 쓰면 API가 시작하지 않습니다.

## GitHub Actions

`.github/workflows/ci.yml`이 API 테스트, 웹 타입 검사·빌드, ML 검사를 실행하고, `main`이면 배포합니다. `.github/workflows/mobile.yml`은 두 앱의 Android APK와 iOS 빌드를 만듭니다.

저장소 Secrets:

| 이름 | 값 |
| --- | --- |
| `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER` | 서버 주소, SSH 포트, 배포 계정 |
| `DEPLOY_KEY` | 배포 전용 SSH 개인 키 |
| `DEPLOY_KNOWN_HOSTS` | 미리 확인한 서버 호스트 키 |

저장소 변수 `DEPLOY_ENABLED=true`일 때만 배포합니다.

## 배포 순서와 복구

`ops/deploy.sh`가 다음 순서로 실행합니다.

1. 검사를 통과한 커밋의 소스를 새 release 폴더에 풉니다.
2. API 환경(`uv sync --locked`)과 모델 환경(`.model-venv`, Python 3.11)을 준비합니다.
3. 일반 매장용 TFT의 추론 테스트를 실행합니다. Walmart 체크포인트가 있으면 smoke test와 전체 ML 테스트도 실행합니다. 하나라도 실패하거나 건너뛰면 배포를 멈춥니다.
4. 웹을 빌드합니다.
5. SQLite 백업 API로 DB를 백업합니다.
6. `current` 링크를 바꾸고 두 서비스를 재시작한 뒤 `/api/health`의 release가 새 커밋인지 확인합니다.
7. 실패하면 이전 release로 되돌립니다. DB는 덮어쓰지 않습니다.

재시작하는 동안 잠깐 접속이 끊길 수 있습니다. release와 백업은 자동으로 지우지 않습니다.

## 서비스 운영자 계정

공개 가입으로는 운영자가 될 수 없습니다. 서버에서 직접 만듭니다.

```bash
PYTHONPATH=apps/api .venv/bin/python -m app.bootstrap_owner \
  --email '<운영자 이메일>' \
  --credentials-output '<새 파일 경로>'
```

초기 비밀번호는 지정한 새 파일에만 기록됩니다. 전달한 뒤 서버의 파일을 지웁니다.

## 모바일 앱

앱은 두 개이며 한 기기에 함께 설치할 수 있습니다. 둘 다 웹을 정적으로 빌드해 포함하므로, 웹 화면을 바꾸면 앱도 새로 빌드해 설치해야 합니다.

| 앱 | 대상 | 앱 ID | 프로젝트 |
| --- | --- | --- | --- |
| 화개장날 | 점주·직원 | `kr.milky.hwagae` | `apps/mobile` |
| 화개장날 관리자 | 서비스 운영자 | `kr.milky.hwagae.admin` | `apps/mobile-admin` |

화개장날 앱에는 관리자 페이지가 없고, 운영자가 로그인하면 관리자 앱이나 웹 관리자 페이지로 안내합니다. 화개장날 관리자 앱은 운영자 화면(계약·초대, AI 연결, 점주 관리)으로 바로 열리고 매장 화면은 들어가지 않으며, 점주·직원이 로그인하면 화개장날 앱으로 안내합니다. `scripts/build-mobile.mjs`가 `store`(기본)·`admin` 중 하나로 빌드하고, 웹에는 `NEXT_PUBLIC_HWAGAE_APP`으로 알려줍니다.

```bash
npm run mobile:sync            # 화개장날: 웹 정적 빌드 후 Android·iOS 프로젝트에 반영
npm run mobile:android         # 화개장날: Android Studio 열기
npm run mobile:ios             # 화개장날: Xcode 열기
npm run mobile:admin:sync      # 화개장날 관리자: 웹 정적 빌드 후 반영
npm run mobile:admin:android   # 화개장날 관리자: Android Studio 열기
npm run mobile:admin:ios       # 화개장날 관리자: Xcode 열기
npm run mobile:check           # 두 앱을 모두 빌드(mobile:build, mobile:admin:build)한 뒤 검사
```

GitHub Actions의 "Build mobile apps" 실행 결과에서 앱마다 debug APK와 서명하지 않은 iOS 빌드를 받을 수 있습니다(`hwagae-*`, `hwagae-admin-*`). 두 앱의 아이콘과 시작 화면은 `apps/mobile/resources/mark.svg`에서 `node scripts/mobile-assets.mjs`로 다시 만들며, 관리자 앱은 짙은 남색 배경으로 구분합니다.
