# Ubuntu CI/CD — Docker 미사용

## 현재 상태

GitHub Actions와 배포 스크립트·systemd·Nginx 예제를 준비했습니다.
CI는 API 테스트·웹 타입·웹 빌드·배포 스크립트 문법을 검사합니다.
CD는 DEPLOY_ENABLED=true일 때 검사를 통과한 main 또는 명시적으로 선택한 수동 배포에서 실행합니다.
대상은 Ubuntu 22.04 ARM64 서버, 서비스 주소는 https://hwagae.milky.kr 입니다.
관리 접속은 ubuntu, Actions 배포는 별도 hwagae 계정과 전용 키를 사용합니다.
기존 navi·eom 서비스와 Minecraft는 별도이며 설정·런타임을 교체하지 않습니다.
PR #2의 main 병합과 GitHub Actions 자동 배포까지 완료했습니다. DEPLOY_ENABLED=true입니다.
검증 실행: https://github.com/hminkoo10/Hwagae_jangnal/actions/runs/40062180934

## 구성

브라우저 → Nginx → /api/는 FastAPI(8000), 나머지는 Next.js(3000).
두 앱은 127.0.0.1에 바인딩하고 systemd가 관리합니다.
코드는 /srv/hwagae/releases/커밋에 보관하며 current 링크로 선택합니다.
DB는 코드 밖의 /srv/hwagae/shared/hwagae.sqlite3에 유지합니다.

### 선택적 TFT 시연 실행 환경

검증한 체크포인트를 `/srv/hwagae/shared/models/best-epoch=02-val_loss=3.9847.ckpt`에 배치하면 다음 배포부터 해당 release의 `.model-venv`에 Python 3.11 추론 환경을 설치합니다. 파일 해시는 `ml/metadata/manifest.json`과 일치해야 하며 파일은 Git에 넣지 않습니다.

배포는 실제 체크포인트로 smoke test와 전체 ML unittest를 실행한 다음 코드를 활성화합니다. 테스트 생략도 실패입니다. 모델 파일이 없으면 기존 웹·API 배포만 수행합니다. API의 Python 3.14 환경은 유지합니다.

API가 별도 모델 자식 프로세스를 관리하므로 새 포트·systemd 서비스·sudo 권한을 추가하지 않습니다. 시작 시 백그라운드에서 샘플을 실행해 준비하고, 로그인 후 `/api/model-demo`에서 `disabled/starting/ready/unavailable`을 확인합니다. 모델 준비와 API `/health`는 별개입니다. 체크포인트나 환경을 수정한 뒤에는 API를 재시작합니다.

로컬은 `uv venv --no-project --python 3.11 .model-venv`로 환경을 만든 뒤 `ml/README.md`의 고정 요구사항을 설치합니다. `TFT_CHECKPOINT_PATH`를 실제 파일로 지정한 API 프로세스에서 체험할 수 있습니다. `.model-venv`는 Git 제외 대상입니다.

## 대상 확인 후 1회 준비

1. Ubuntu 버전·CPU·메모리·디스크, SSH 계정·포트, 기존 80·443·3000·8000 서비스 점검.
2. GitHub 실행기에서 SSH 접속 가능한지 확인. 내부망 전용이면 runner 등 CD 방식을 조정.
3. Node.js 24와 npm은 /opt/hwagae/node, uv는 /opt/hwagae/bin, Python 3.14는 hwagae 계정에서 준비.
4. 전용 hwagae 계정과 /srv/hwagae/{incoming,releases,shared}, /etc/hwagae 준비.
5. /etc/hwagae/hwagae.env를 만들고 읽기 권한을 제한. 비밀값은 Git·로그·채팅에 남기지 않음.
6. ops의 service 파일 설치. Node 경로 /opt/hwagae/node/bin/node도 실제 위치 확인.
7. 배포 계정의 sudo는 두 서비스 restart·stop으로 제한.
8. 기존 사이트를 보존하며 Nginx·도메인·HTTPS 구성. nginx -t 성공 후 반영.
9. 첫 배포 성공 후 두 서비스를 부팅 시 자동 시작하도록 활성화.

기존 Nginx 설정·서비스를 교체하지 않습니다. 현재 서버는 ops/nginx.cloudflare.conf를 별도 사이트로 설치합니다.
인증서는 /etc/hwagae/tls에 보관하며 Cloudflare Origin CA의 *.milky.kr 인증서를 사용합니다.
Cloudflare 프록시를 유지해야 합니다. 원본 인증서는 일반 브라우저의 직접 접속용 인증서가 아닙니다.
기존 서버의 cloudflare-ips.conf와 cloudflare-realip.conf에 있는 신뢰 CIDR만 사용합니다.
API 응답은 no-store, 로그인 제한은 복원한 방문자 IP 기준입니다.

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
호스트키는 기존 PC의 신뢰 기록과 대조합니다. 검사를 끄거나 배포 중 자동 신뢰하지 않습니다.
수동 배포는 Actions의 Run workflow에서 브랜치를 선택하고 deploy=true로 요청합니다.
이 기능은 workflow 파일이 main에 존재한 뒤 사용할 수 있습니다. 단순 수동 검사는 deploy=false입니다.

## 배포 순서와 복구

### TFT의 실제 Ubuntu ARM64 검증

Actions의 **Verify and deploy → Run workflow**에서 검증할 브랜치를 선택하고
`verify_tft=true`, `deploy=false`, `tft_checkpoint=<서버의 기존 체크포인트 절대 경로>`를 지정한다.
기본 체크포인트 위치는 `/srv/hwagae/shared/models/best-epoch=02-val_loss=3.9847.ckpt`이다.
현재 검증은 서버에 이미 존재하는 모델 파일만 사용하므로 `tft_checkpoint_asset_id`는 빈 값으로 둔다.
기존 draft 첨부파일과 토큰 권한은 변경하지 않으며 모델 파일을 새로 전달하지 않는다.
요청 경로의 파일이 없거나 해시가 다르면 `/srv/hwagae/` 프로젝트 폴더 내부의 기존 `*.ckpt`만
읽기 전용으로 검색한다. 디렉터리·파일 심볼릭 링크는 따라가지 않으며 manifest의 SHA-256과
일치하는 파일만 선택한다. 선택 경로·실제 SHA-256과 검색 결과는 `checkpoint.json`에 기록한다.
검색은 체크포인트 후보 1,000개·디렉터리 20,000개로 제한하고, 256 MiB를 넘는 파일은 해시 계산에서 제외한다.
제한 도달이나 읽기 오류는 보고서에 남기며 이 경우 프로젝트 전체를 확인했다고 표현하지 않는다.
다른 사용자 홈이나 프로젝트 밖 파일시스템은 검색하지 않는다. `/srv/hwagae/releases/`에서 일치하는
기존 파일이 발견되어도 읽기만 수행하며 운영 release와 모델 파일을 수정하지 않는다.
기존 production environment의 `DEPLOY_*` secrets로 접속하며 개인키나 서버 환경 파일을 출력하지 않는다.
`verify_tft=true`이면 배포 job은 실행되지 않는다. API·웹 CI가 통과한 뒤 서버 검증이 시작된다.

`ops/verify-tft.sh COMMIT_SHA --checkpoint ABSOLUTE_PATH`는 아래 과정을 수행한다.

1. `/srv/hwagae/shared/tft-verification/<sha>/`에 해당 Git 소스와 검증 결과를 보관한다.
2. 실제 OS가 Ubuntu/Linux이고 CPU가 aarch64/arm64인지 확인하고 메모리·디스크·CPU·커널 정보를 기록한다.
3. 요청한 기존 체크포인트 또는 위 제한된 검색에서 SHA-256이 일치하는 파일을 확인한다. 체크포인트 내용은 보고서에 넣지 않는다.
4. 검증 폴더 안에 Python 3.11 모델 환경을 만들고 `ml/requirements-inference.txt`를 설치한 뒤 PyTorch·PyTorch Forecasting import와 CPU tensor 실행을 확인한다. 모델이 없어도 여기까지는 수행하고 `missing_checkpoint`로 종료한다. 설치/import 자체가 실패하면 그 단계의 실패와 로그를 남긴다. 어느 경우에도 추론 성공으로 표시하지 않는다.
5. 체크포인트가 확인된 경우에만 10상품의 7일×5분위수 smoke test, 전체 unittest와 10/50상품 cold·warm·최고 RSS 측정을 실행한다. 이후 별도 Python 3.14 API 환경에 기존 `uv.lock`을 설치하고, `ml.bridge`로 Python 3.11 worker를 호출해 샘플의 7일×3분위수 및 이력 부족 응답을 비교하고 API 테스트를 실행한다.
6. 상태·설치 로그·패키지 버전·실행 시간·비교 결과를 Actions artifact `tft-arm64-<sha>-<attempt>`로 수집한다. 비교 오차는 기존 smoke test의 `atol=1e-4`, `rtol=1e-5`이며 다른 아키텍처에서 실패하면 실패한 그대로 기록한다.

전송 전 실패도 `runner-status.json`에 기록한다. 원격 보고서의 검증 실행 ID를 현재 실행과 대조하며,
같은 커밋 재검증 시 이전 서버 보고서는 날짜가 붙은 폴더로 보관한다. 모델 다운로드나 파일 전달 성공만으로 추론 검증 성공을 판정하지 않는다.

이 작업은 검증 폴더의 별도 DB와 별도 Python 환경을 사용한다. 운영 `current` 링크, 운영 DB,
`/etc/hwagae/hwagae.env`, systemd 및 Nginx를 변경하지 않는다. 서비스 배포/활성화는 별도 작업이다.
모델 체크포인트를 Git이나 검증 보고서 artifact에 포함하지 않는다. 기존 서버 모델 파일을 수정하지 않는다.
보고서의 `status=passed`와 해당 커밋을 확인하기 전에는 ARM64 또는 Python 간 연결 검증이 완료되었다고 표기하지 않는다.

공식 [PyTorch CPU wheel 목록](https://download.pytorch.org/whl/cpu/torch/)에서
`torch-2.11.0+cpu-cp311-cp311-manylinux_2_28_aarch64.whl`의 존재를 확인했다.
2026-10-24 실제 서버에서 Python 3.11.14 환경 설치와 CPU 연산까지 성공했다.
[검증 실행](https://github.com/hminkoo10/Hwagae_jangnal/actions/runs/40067229667)에서
`/srv/hwagae` 내부에 체크포인트 후보가 0개였으므로 추론·전체 unittest·10/50상품 측정은 실행하지 않았다.
설치 성공과 모델 추론 성공을 구분하며 [원본 증거](../ml/evaluation/server-environment/README.md)를 보존한다.

### 운영 배포

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
## 운영 확인 기록

- 2026-10-24: 서버 접속과 기존 서비스 조사 완료. 3000·8000 포트 미사용 확인.
- 앱 전용 계정·Node 24.22.1·uv 0.10.6·Python 3.14.3 준비.
- 전용 배포 계정은 두 앱 서비스의 restart·stop만 sudo 허용.
- 운영 초기 비밀번호는 서버에서 무작위 생성하며 저장소·Actions Secrets에 넣지 않음.
- b3d37d9 첫 공개 배포 완료. HTTPS 웹·API 상태·운영 계정 로그인·점주/직원 매장 범위 확인.
- 실시간 7일 날씨·10상품 7일 예측·재고 미입력 시 발주 보류 확인.
- 두 systemd 서비스의 부팅 시 자동 시작과 Nginx 문법 검사 통과.
- 기존 navi/eom HTTPS 200, Docker 컨테이너·Minecraft 리스닝 유지 확인.
- PR #2 main 병합 후 API 테스트·웹 타입/빌드·Deploy Ubuntu 모두 성공.
- 운영 release가 병합 커밋 3a1b8dde31e0335d4928c80cec97433a8bb98f98과 일치함을 확인.
- 자동 배포 전후 stores/products/sales/inventory/orders/forecasts 건수 2/20/1680/0/0/1 유지.
- backup-20261024T042505Z.sqlite3 생성, 읽기 전용 integrity_check=ok와 동일 테이블 건수 확인.
- 이후 main push/PR 병합은 검사 통과 후 자동 배포. 앱 시작 실패 시 이전 코드로 복귀하며 DB는 보존.
- 운영 로그인 정보는 배포 담당 PC의 .ssh/hwagae-login.txt에 별도로 보관합니다.

출처: [GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).
Cloudflare: [Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/),
[방문자 IP 헤더](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
