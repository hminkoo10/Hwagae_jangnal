# 화개장날 모바일 아이콘

`mark.svg`가 원본이다. 웹의 파란색 `#2478F5`, 청록색 가게 차양, 날씨를 나타내는 작은 해를 사용한다. 글꼴·외부 이미지에 의존하지 않는다.

저장소 루트에서 실행:

```sh
node scripts/mobile-assets.mjs
```

기존 Next 의존성 `sharp`로 Android 5개 밀도의 일반·원형·adaptive 아이콘, Android 가로·세로 시작 화면, iOS 1024px 불투명 아이콘과 시작 화면을 재생성한다. Android vector도 같은 SVG에서 생성한다.

Adaptive foreground는 108dp 캔버스의 중앙 66dp 안전 영역 안에 배치했다. Android 12 이상은 `@drawable/hwagae_splash_icon`과 배경색 `#F5F8FC`를 시작 화면 테마에서 사용할 수 있다. iOS 아이콘은 운영체제가 모서리를 처리하므로 원본 모서리를 자르지 않는다.

참고: [Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive), [Android splash screens](https://developer.android.com/develop/ui/views/launch/splash-screen).
