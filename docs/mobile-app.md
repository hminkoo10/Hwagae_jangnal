# 화개장날 Android · iPhone 앱

웹과 같은 판매·날씨·TFT 예측·재고·발주 기능을 Android와 iPhone 앱에서 사용합니다. 앱 화면 파일은 설치 패키지에 포함하고, 로그인과 매장 자료는 기존 HTTPS API `https://hwagae.milky.kr/api`에 연결합니다. 기기에서 TFT를 학습하거나 실행하지 않습니다.

| 항목 | 설정 |
| --- | --- |
| 앱 이름 | 화개장날 |
| 앱 ID | `kr.milky.hwagae` |
| 구성 | Capacitor 8 · 기존 웹 화면 · 기존 FastAPI 서버 |
| Android | 설치 가능한 테스트용 debug APK |
| iOS | Xcode 프로젝트 · 서명 없는 Simulator용 앱 |
| 계정과 자료 | 웹과 같은 계정·매장·판매·발주 기록 |
| 네트워크 | 로그인·자료 조회·예측·발주 저장에는 인터넷 필요 |
| 최소 기기 환경 | Android 7 이상 + Android System WebView 111 이상 / iOS 16.4 이상 |

## 휴대폰 · 태블릿 화면

하나의 앱이 화면 폭에 맞춰 배치를 바꿉니다. Android 휴대폰·태블릿, iPhone·iPad를 대상으로 하며 세로·가로 회전을 지원합니다.

| 화면 폭(CSS px) | 메뉴와 내용 |
| --- | --- |
| 320~600 | 상단 가로 메뉴, 한 열 중심 배치, 지표 두 열, 날짜 입력 전체 폭 |
| 601~850 | 왼쪽 아이콘 메뉴, 넓어진 차트, 운영 요약 두 열 |
| 851~1250 | 왼쪽 글자 메뉴, 공간에 맞춘 카드·차트 배치, 운영 요약은 아래로 이동 |
| 1251 이상 | 넓은 대시보드와 오른쪽 운영 요약 |

폰에서는 차트·긴 표 내부만 좌우로 넘깁니다. 앱 전체가 가로로 밀리지 않도록 했으며, 네이티브 입력 글자는 16px 이상, 버튼 높이는 44px 이상으로 맞췄습니다. 태블릿에서도 입력·공유·발주 기능은 동일합니다.

브라우저에서 320·390·430·768·820·1024·1180px 홈과 재고·입고 모달을 확인했습니다. 844×390 가로 화면과 1366×1024 큰 태블릿 화면도 확인합니다. 이 검사는 레이아웃 검증이며, 실제 iPhone·Android의 키보드·노치·공유 창 검증을 대신하지 않습니다.

## 먼저 테스트하기

### Android

1. [GitHub Actions](https://github.com/hminkoo10/Hwagae_jangnal/actions/workflows/mobile.yml)에서 원하는 커밋의 **Build mobile apps** 실행을 엽니다. `Android debug APK`가 성공했는지 확인합니다.
2. 실행 하단 **Artifacts → hwagae-android-debug**를 받아 압축을 풉니다. 저장소가 비공개이므로 GitHub 접근 권한이 필요합니다.
3. `app-debug.apk`를 Android 기기로 옮겨 설치합니다. 기기가 요구하면 해당 파일을 연 앱에 대해서만 APK 설치를 허용합니다.
4. **화개장날**을 실행하고 웹에서 쓰던 계정으로 로그인합니다.

이 PC의 점주 계정 정보는 [로그인 정보 파일](C:/Users/구현민/.ssh/hwagae-login.txt)에 있습니다. 비밀번호를 소스·앱 설정·GitHub에 넣지 않습니다. 다른 팀원은 전달받은 별도 계정을 사용합니다.

debug APK는 해커톤 직접 테스트용입니다. Play Store 배포에는 별도 release 서명과 AAB 빌드가 필요합니다. CI의 임시 debug 서명 키는 실행마다 달라질 수 있으므로 기존 테스트 앱을 업데이트할 때 서명이 다르다는 오류가 나면 해당 테스트 앱을 삭제한 뒤 새 APK를 설치합니다. 서버에 저장한 매장·발주는 남고 기기 로그인 상태는 초기화됩니다.

### iPhone / iOS Simulator

`hwagae-ios-simulator` Artifact 안의 ZIP을 풀면 `App.app`이 나옵니다. **Mac의 iOS Simulator용**이며 iPhone에 직접 설치하는 IPA가 아닙니다. Mac에서 Xcode의 Simulator를 실행하고 호환되는 시뮬레이터 창에 `App.app`을 끌어 넣어 테스트합니다.

실제 iPhone에서는 Mac의 Xcode로 프로젝트를 열고 **Signing & Capabilities → Team**을 선택한 뒤 연결한 iPhone에 빌드합니다. 개인 Apple 계정으로 가능한 개발용 설치와 Apple Developer Program의 TestFlight/App Store 배포는 별개입니다. 저장소 CI에는 Apple 인증서·프로비저닝 프로파일·자동 배포 설정을 넣지 않습니다.

## 공통 기능 확인 순서

1. 로그인 → 매장 선택 → **실시간 TFT 테스트 매장 만들기**로 테스트 자료를 준비합니다.
2. **7일 판매 예측**에서 실제 예보·날짜·모델 이름을 확인합니다. 가상 판매·재고와 합성 학습 TFT라는 표시는 웹과 같습니다.
3. **재고 확인**에서 재고·입고 예정 수량을 바꾸고 **발주 계획**에서 추천을 다시 계산합니다.
4. 발주 수량을 수정·저장·확정한 뒤 CSV와 Excel을 내보냅니다. OS 공유 창에서 파일 앱·메일 등 원하는 대상을 직접 고릅니다.
5. 판매 자료 업로드에서 기기의 파일 선택기로 CSV/Excel 파일을 선택합니다. 앱에 저장소 전체 접근 권한을 줄 필요가 없습니다.
6. 앱을 다시 열어 로그인·저장된 발주를 확인합니다. 로그아웃 후에는 로그인 화면으로 돌아오는지 확인합니다.

내보내기 파일은 앱 전용 임시 캐시에 만든 뒤 OS 공유 창에 전달합니다. 사용자가 공유 대상을 선택하기 전에는 다른 앱이나 상대에게 자동 전송하지 않습니다. 캐시는 OS가 정리할 수 있으므로 보관할 파일은 공유 창에서 파일 앱 등에 저장합니다.

자세한 시연 데이터·TFT 입력 규칙은 [실시간 예보 테스트 안내](live-weather-test.md)를 참고합니다.

## 개발 명령

저장소 루트에서 실행합니다. Node.js 22 이상이 필요하며 CI는 Node.js 24를 사용합니다.

```bash
npm ci
npm run mobile:build
npm run mobile:check
npm run mobile:sync
```

| 명령 | 동작 |
| --- | --- |
| `npm run mobile:build` | 앱에 포함할 정적 웹 화면 빌드 |
| `npm run mobile:check` | 앱 설정·정적 빌드 결과의 필수 조건 검사 |
| `npm run mobile:sync` | 정적 화면 빌드 후 Android·iOS 프로젝트에 동기화 |
| `npm run mobile:android` | Android Studio 프로젝트 열기 |
| `npm run mobile:ios` | Mac에서 Xcode 프로젝트 열기 |

웹 화면이나 앱 플러그인을 변경하면 `mobile:sync` 후 네이티브 앱을 다시 빌드합니다. 웹 서버만 배포해도 이미 설치된 앱의 화면 파일이 자동 교체되지는 않습니다. 서버 API와 데이터는 기존 운영 서버를 사용합니다.

앱 빌드는 임시 폴더에서 실행한 뒤 `apps/mobile/www`에 결과를 복사합니다. 실행 중인 웹 개발 서버의 `.next`와 로컬 `.env`는 건드리지 않습니다. 서버는 앱 출처 `https://localhost`(Android), `capacitor://localhost`(iOS)를 명시적으로 허용하며, 각 API의 로그인·매장 권한 검사는 그대로 적용합니다.

아이콘·시작 화면은 `apps/mobile/resources/mark.svg`에서 만들며 `node scripts/mobile-assets.mjs`로 재생성합니다.

### Android 로컬 빌드

필요 환경: Android Studio 2025.2.1 이상, JDK21, Android SDK36, Build Tools35/36. CLI 빌드는 Android Studio 대신 command-line tools로 SDK를 준비해도 됩니다. 프로젝트 Gradle wrapper를 사용하므로 전역 Gradle 설치는 필요하지 않습니다.

PowerShell에서 실제 설치 경로에 맞춰 설정한 뒤 빌드합니다. 아래 환경 변수 설정은 현재 터미널에만 적용됩니다.

```powershell
$env:JAVA_HOME = 'C:\실제\JDK21\경로'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run mobile:sync
Push-Location apps/mobile/android
.\gradlew.bat --no-daemon assembleDebug
Pop-Location
```

결과: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

2026-10-24 확인한 이 PC에는 JDK25·adb만 있고 Android Studio·SDK·JDK21·에뮬레이터는 아직 없습니다. 연결된 Android 기기도 없었습니다. JDK25는 이 프로젝트의 Gradle8.x 실행용으로 쓰지 않습니다. CI에서 APK를 받는 데 로컬 SDK 설치는 필요하지 않습니다.

### iOS 로컬 빌드

필요 환경: macOS, Xcode26 이상. iOS 프로젝트는 Swift Package Manager를 사용합니다.

```bash
npm run mobile:sync
npm run mobile:ios
```

Xcode에서 `App` scheme과 Simulator 또는 연결한 iPhone을 고릅니다. 실제 iPhone 설치에는 해당 기기에 맞는 개발 서명이 필요합니다. Windows에서는 Xcode 프로젝트를 수정할 수 있지만 iOS 네이티브 빌드를 실행할 수는 없습니다.

## CI 검증 범위

[mobile.yml](../.github/workflows/mobile.yml)은 모바일·웹·관련 패키지 변경 PR, main 변경, 수동 실행에서 동작합니다.

- Android: Ubuntu24.04 + Java21 → 정적 화면·설정 검사 → `assembleDebug` → APK 보관.
- iOS: macOS26 → 정적 화면·설정 검사 → 서명 없이 Simulator용 컴파일 → `.app` ZIP 보관.
- 산출물 보관 기간은 7일입니다. 만료되면 Actions에서 다시 실행합니다.
- CI 빌드 성공은 컴파일 검증입니다. 실제 기기 터치·파일 선택·공유·로그인 성공을 대신하지 않습니다.
- 앱 스토어 업로드·운영 데이터 변경·앱 자동 배포는 수행하지 않습니다.

실제 기기에서는 작은 화면과 가로 화면, 키보드가 열린 로그인·수량 입력, Android 뒤로 가기, iPhone 안전 영역, 파일 선택 취소, 공유 취소, 네트워크 끊김·재연결을 확인합니다.

공식 환경 안내: [Capacitor](https://capacitorjs.com/docs/getting-started/environment-setup), [Android SDK](https://developer.android.com/tools/sdkmanager), [Gradle의 Java 호환 범위](https://docs.gradle.org/current/userguide/compatibility.html), [GitHub macOS26 이미지](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md).
