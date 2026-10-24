# Colab A100에서 6회 새 학습

[paired_tft_a100.ipynb](../../notebooks/paired_tft_a100.ipynb)를 Colab에서 열고 A100 GPU 런타임을 선택한다. **노트북 작성 시 실제 Colab 설치·학습은 아직 검증하지 않았다.** 셀 구문 검증만 완료했으며, 실제 설치 성공·GPU 연산·완료 여부는 실행 후 남는 기록으로 확인한다.

이 노트북은 현재 ml.run_multiseed와 ml.train_ablation을 그대로 호출한다. 원본 학습 노트북, 기존 체크포인트·전처리 객체, 기존 실험 계획을 변경하지 않는다. GitHub/API 인증 토큰 없이 원본 입력을 포함한 코드 ZIP을 업로드하고 본인 Drive를 결과 보존용으로 마운트한다. 학교 계정 Drive에 원본 폴더가 없어도 ZIP에 포함된 입력으로 실행할 수 있다.

## 입력과 저장 위치

코드 ZIP은 저장소 구조를 유지해야 한다. 최소한 ml/__init__.py, ml/run_multiseed.py, ml/train_ablation.py, ml/evaluate.py, ml/requirements-inference.txt, ml/notebooks/startup_thon_1.ipynb 및 apps/api/app/forecasting.py가 필요하다. API 파일은 요일 기준선 함수의 읽기 전용 평가에 사용하며 서버를 실행하지 않는다. ZIP이 저장소 이름의 최상위 폴더를 포함해도 된다.

ZIP 루트의 MANIFEST.json은 자신을 제외한 모든 파일의 path·bytes·sha256를 files 배열에 기록해야 한다. 경로는 저장소 루트 기준이며 슬래시를 사용한다. 압축 해제 후 파일 목록이 정확히 같은지 검사하고 각 파일의 크기·SHA-256을 확인한다. 목록 누락·추가 파일·중복 경로·해시 불일치가 있으면 설치와 학습 전에 중단한다.

ZIP 입력 경로는 다음과 같다. 체크포인트는 포함하지 않는다.

- inputs/data/train.csv.zip, inputs/data/weather.csv.zip, inputs/data/key.csv.zip
- inputs/reference/run_config.json
- inputs/reference/selected_series.csv, inputs/reference/validation_predictions.csv, inputs/reference/test_predictions.csv

ZIP에 inputs 폴더가 없는 경우에만 Drive 원본을 사용한다. 기본 대체 경로는 /content/drive/MyDrive/weather_order_tft이며, 데이터는 해당 폴더의 train.csv.zip/weather.csv.zip/key.csv.zip, 참조 실행 4개 파일은 runs/walmart_20261024T020058Z 아래에 있어야 한다. 실제 위치가 다르면 DRIVE_SOURCE를 수정한다. inputs 폴더가 있지만 불완전하면 다른 원본과 섞지 않고 중단한다. 각 데이터 ZIP은 압축하지 않은 같은 이름의 CSV로 대신할 수 있으나 CSV와 ZIP이 동시에 있으면 중단한다.

입력은 /content/tft-paired-inputs로 복사하고 원본과 복사본의 SHA-256을 비교한다. 기존 체크포인트를 읽거나 복사하지 않는다. 실험 산출물은 Drive의 tft-paired-experiments/paired-tft-a100-<UTC 시각> 새 폴더에 저장한다. 입력·환경·코드·출력 폴더가 이미 있으면 조용히 덮어쓰지 않는다.

## 환경과 실행 순서

1. A100 GPU 이름·UUID·NVIDIA 드라이버를 확인한다.
2. 입력을 포함한 코드 ZIP 하나를 업로드한다. 모든 파일을 MANIFEST.json과 비교한다. 전달받은 ZIP SHA-256을 EXPECTED_CODE_SHA256에 넣으면 배포본과 일치하는지도 검사한다. 비워 두면 ZIP 자체는 실제 해시만 기록한다.
3. Drive를 결과 보존용으로 마운트하고 ZIP에 포함된 입력을 /content로 복사한다. ZIP 입력이 없을 때만 Drive 원본으로 대체한다.
4. uv 0.13.1로 Python 3.11.14 독립 환경을 만든다. Colab 기본 커널은 Drive/UI에만 사용한다.
5. 전체 패키지 버전을 기존 requirements-inference.txt로 고정하되 torch 2.11.0+cpu와 CPU index를 CUDA wheel/index로 치환한다. torch·forecasting·Lightning 등 주요 8종과 Linux CUDA 전이 의존성을 포함한 전체 freeze를 기록한다.
6. CUDA/BF16 순전파·역전파 검사 및 주요 패키지 import를 확인한다.
7. **plan → run → summarize** 셀을 각각 실행한다. 여섯 실행이 모두 완료되기 전에는 평가표를 만들지 않는다.

드라이버 R580 이상에서는 PyTorch 2.11.0+cu130을 선택한다. 그보다 낮고 Linux 드라이버 525.60.13 이상이면 2.11.0+cu128을 후보로 선택하며 실제 GPU 검사에 통과해야 한다. 그보다 낮은 드라이버에서는 중단한다. CUDA 12.x의 minor compatibility는 PTX나 새로운 기능을 모두 보장하지 않으므로, 버전 숫자 확인만으로 검증 완료라고 하지 않는다. 공식 근거는 [PyTorch 설치 표](https://pytorch.org/get-started/previous-versions/)와 [NVIDIA CUDA minor compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)다.

설치가 실패하거나 GPU 검사가 실패하면 학습을 시작하지 않는다. 패키지·wheel·Python·GPU를 바꾸어야 하면 새 런타임과 새 실험 폴더에서 계획부터 다시 만든다. 한 계획에 cu130/cu128 또는 다른 Python 패치를 혼합하지 않는다. Colab Python 3.11.14/A100 환경은 기존 Windows Python 3.11.0/RTX 5060 환경과 별개의 실험이다.

## 비교 규약과 결과

seed 42·43·44 × weather/no-weather를 모두 새로 학습한다. --reuse-no-weather-42 옵션은 전달하지 않는다. 여섯 실행은 같은 A100, Python, 패키지, BF16, batch 128, 최대 20 epoch와 검증 loss 기반 선택 정책을 사용한다. 각 모델의 완료 epoch 수가 early stopping으로 달라질 수 있다.

시계열 선정은 원본 seed 42와 저장된 200개 매장×상품에 고정한다. 학습 seed만 바꾸며 테스트를 보고 seed를 추가·제외하지 않는다. 날씨는 과거 관측과 decoder persistence다. 11개 날씨 값·결측·미량 강수 특징을 제거하면 모델의 입력 차원과 파라미터 수도 달라지므로 파라미터 수까지 맞춘 비교나 인과 효과 실험이 아니다.

summary/에는 metrics.csv, api-baseline.csv, paired-differences.csv, summary.csv, manifest.json이 생성된다. 원본 전체 7,973행과 연속 56일 실제 관측 이력이 있는 1,701행을 구분한다. API 요일 기준선은 실제 함수와 기준일 이전 84일 관측을 사용한다. 쌍 차이는 날씨 포함 − 제거이며, 표준편차는 세 seed에 대한 표본 표준편차(ddof=1)다. 세 seed만으로 통계적 유의성이나 날씨의 인과 효과를 주장하지 않는다.

다음 증거를 함께 보관한다.

- experiment-plan.json: 여섯 실행 모두 reuse:false, 고정 코드·원본 노트북·입력 해시, 학습 조건.
- colab-runtime.json: A100 UUID/driver, 실제 Python·CUDA·패키지 버전, BF16 검사, fresh_model_fits:6/reused_model_fits:0.
- requirements-installed.txt와 requirements-paired-a100.txt: 실제 설치 전체 버전과 설치 요구사항.
- source-code-zip-sha256.txt와 source-bundle-manifest.json, 실행별 protocol.json/completion.json/예측 CSV/체크포인트/로그. colab-runtime.json의 input_origin은 uploaded_bundle 또는 drive_original_fallback이다.
- status.json과 summary/의 평가표·해시.

실제 새 실행 여부는 위 계획의 여섯 reuse:false와 런타임 증거로 확인한다. 공통 요약 코드도 재사용 계획이 있을 때만 과거 seed 42 재사용 설명을 추가한다. 기존 발표 수치·Windows 결과·과거 A100 단일 실행을 이 여섯 seed 결과에 섞지 않는다.

## 중단과 재실행

Colab의 A100 배정과 실행 시간은 보장되지 않는다. /content는 런타임이 종료되면 사라질 수 있지만 Drive 결과는 남는다. 중간 실패로 생성된 모델 폴더는 현재 실행기가 재개하거나 덮어쓰지 않는다. 실패 로그를 보존하고 새 실험 폴더에서 다시 시작한다.

같은 세션의 완료 모델만 있는 경우 실행기는 완료 증거를 검사해 건너뛸 수 있다. 런타임/GPU UUID/드라이버/환경이 바뀐 경우에는 기존 완료 모델과 새 실행을 같은 3개 쌍으로 합치지 않는다. Drive 원본·기존 모델·실험 기록은 삭제하지 않는다.
