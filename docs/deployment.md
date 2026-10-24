# Ubuntu CI/CD — Docker 미사용

## 현재 상태

GitHub Actions와 배포 스크립트·systemd·Nginx 예제를 준비했습니다.
CI는 API 테스트·웹 타입·웹 빌드·배포 스크립트 문법을 검사합니다.
CD는 검사를 통과한 main에서 DEPLOY_ENABLED=true일 때만 실행합니다.
**대상 Ubuntu 서버의 주소·SSH·도메인은 미확인이고, 실제 서버 연결·설치·배포는 미완료입니다.**
PC의 milky@192.168.175.31은 사용자가 대상이 아니라고 확인했습니다. 이 서버에 적용하지 않습니다.

## 구성

브라우저 → Nginx → /api/는 FastAPI(8000), 나머지는 Next.js(3000).
두 앱은 127.0.0.1에 바인딩하고 systemd가 관리합니다.
코드는 /srv/hwagae/releases/커밋에 보관하며 current 링크로 선택합니다.
DB는 코드 밖의 /srv/hwagae/shared/hwagae.sqlite3에 유지합니다.

## 대상 확인 후 1회 준비

1. Ubuntu 버전·CPU·메모리·디스크, SSH 계정·포트, 기존 80·443·3000·8000 서비스 점검.
2. GitHub 실행기에서 SSH 접속 가능한지 확인. 내부망 전용이면 runner 등 CD 방식을 조정.
3. Node.js 24, npm, uv 0.10.6 이상, Python 3.14, curl·tar·flock·Nginx 준비.
4. 전용 hwagae 계정과 /srv/hwagae/{incoming,releases,shared}, /etc/hwagae 준비.
5. /etc/hwagae/hwagae.env를 만들고 읽기 권한을 제한. 비밀값은 Git·로그·채팅에 남기지 않음.
6. ops의 service 파일 설치. Node 경로 /usr/bin/node도 실제 위치 확인.
7. 배포 계정의 sudo는 두 서비스 restart·stop으로 제한.
8. 기존 사이트를 보존하며 Nginx·도메인·HTTPS 구성. nginx -t 성공 후 반영.
9. 첫 배포 성공 후 두 서비스를 부팅 시 자동 시작하도록 활성화.

서버 정보 확인 전 일괄 설치하지 않습니다. 기존 Nginx 설정·서비스를 임의로 교체하지 않습니다.

환경 파일 예시:

```dotenv
APP_ENV=production
SEED_DEMO=true
DEMO_PASSWORD=서버에서_16자_이상의_별도_비밀번호_설정
CORS_ORIGINS=https://선택한도메인
# FORECAST_PROVIDER=ml.predict:predict
```

production에서 기본 체험 비밀번호를 사용하면 시작이 실패합니다. 공개 빌드는 빠른 체험 로그인을 숨깁니다.
초기 계정은 별도 비밀번호로 일반 로그인합니다. 환경변수는 최초 생성용이며 기존 계정 비밀번호를 자동 변경하지 않습니다.
가상 체험 매장·계정이 생성되며, 실제 점포 운영의 계정 관리까지 구현한 상태는 아닙니다.

계정·명령 위치 확인 후 visudo로 적용할 제한 예시:

```sudoers
hwagae ALL=(root) NOPASSWD: /usr/bin/systemctl restart hwagae-api.service hwagae-web.service, /usr/bin/systemctl stop hwagae-api.service hwagae-web.service
```

## GitHub 설정

저장소 또는 production environment의 Actions Secrets:

| 이름 | 값 |
| --- | --- |
| DEPLOY_HOST | 실제 서버 DNS 또는 IP |
| DEPLOY_USER | 전용 SSH 배포 계정 |
| DEPLOY_PORT | SSH 포트, 기본 22 |
| DEPLOY_KEY | 전용 배포 개인키. Git·채팅에 넣지 않음 |
| DEPLOY_KNOWN_HOSTS | 별도로 지문을 확인한 서버 호스트 키 |

repository variable DEPLOY_ENABLED=true는 **서버 준비와 첫 배포 확인 뒤** 활성화합니다.
현재는 설정·활성화하지 않았습니다. 호스트키 검사를 끄거나 배포 중 자동 신뢰하지 않습니다.

## 배포 순서와 복구

1. 동일 커밋의 API·웹 검사를 통과합니다.
2. 검증된 Git 소스 아카이브를 SSH/SCP로 전달합니다.
3. 새 release에서 uv sync --locked --no-dev, npm ci, 웹 빌드를 실행합니다.
4. SQLite backup API로 WAL까지 반영한 DB 백업을 만듭니다.
5. current 링크를 전환하고 두 서비스를 재시작합니다.
6. API release SHA와 웹 HTTP 응답을 검사합니다.
7. 실패하면 이전 코드로 복귀합니다. DB는 자동 덮어쓰지 않습니다.

순차 재시작이므로 짧은 중단이 있으며 무중단 배포는 아닙니다.
스키마는 생성 중심 v1입니다. 향후 파괴적 DB 변경은 별도 마이그레이션·복구 검증이 필요합니다.
release·백업을 자동 삭제하지 않으므로 보관 정책은 운영 환경에서 정합니다.
systemd·Nginx·SSH·HTTPS 실제 동작은 대상 서버 연결 후 검증해야 합니다.

출처: [GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).
