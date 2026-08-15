import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

// The Azure mark: a peaked "A" glyph matching the desktop icon and logo.svg.
// Width derives from the viewBox aspect ratio.
export function AzureWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  const aspectRatio = 128 / 128;
  return (
    <Svg
      accessibilityLabel="Azure"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 128 128"
    >
      <Path
        d="M38.25 93.5L64 34.75L89.75 93.5"
        stroke={props.color}
        strokeWidth={11}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M49 72.75H79" stroke={props.color} strokeWidth={9} strokeLinecap="round" />
    </Svg>
  );
}

// Back-compat alias during the rename transition.
export const T3Wordmark = AzureWordmark;
