# 실제 ARM64 서버 확인

2026-10-24 [격리 검증 실행](https://github.com/hminkoo10/Hwagae_jangnal/actions/runs/40067229667)의 원본 JSON 기록이다. Ubuntu 22.04.5 aarch64, 논리 CPU 2개, 메모리 약 11.7GiB에서 Python 3.11.14 모델 전용 환경 설치와 PyTorch CPU·PyTorch Forecasting import 및 CPU 연산까지 성공했다.

`/srv/hwagae` 안을 심볼릭 링크 없이 읽기 검색했다. 접근 오류나 검색 제한 없이 12,908개 디렉터리를 확인했지만 `.ckpt` 후보는 0개였다. 지정된 기존 모델 경로도 없었다. 체크포인트를 추가 전송하지 않고 기존 파일만 사용한다는 사용자 선택에 따라 `missing_checkpoint`로 종료했다.

**서버 smoke, 전체 unittest, 10/50상품 첫·반복 추론 시간과 메모리는 미검증이다.** 설치와 import 성공을 모델 추론 성공으로 해석하지 않는다. 모델이 준비되면 같은 workflow의 `verify_tft=true`, `deploy=false`, 기존 서버 경로를 지정해 재실행할 수 있다. 모델 로드 시 SHA-256을 확인하고 CPU 예상 출력의 절대 `1e-4`·상대 `1e-5` 허용 오차를 그대로 적용한다. 불일치는 통과 처리하거나 오차를 확대하지 않고 원인 확인 대상으로 남긴다.

운영 서비스·DB·현재 배포 링크는 바꾸지 않았다. 검증 환경과 보고서는 `/srv/hwagae/shared/tft-verification/<commit>/`에 있다. 파일 내용과 실행 ID는 `checkpoint.json`, `status.json`, `model-environment.json`, `environment.json`을 따른다.
