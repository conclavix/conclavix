import {
  mdiArrowDown,
  mdiArrowLeftBold,
  mdiArrowRightBold,
  mdiArrowUp,
  mdiCheckBold,
  mdiCheckCircle,
  mdiCheckCircleOutline,
  mdiCheckboxBlankOutline,
  mdiCheckboxMarked,
  mdiCheckboxMarkedCircle,
  mdiCheckboxMarkedOutline,
  mdiChevronDoubleLeft,
  mdiChevronDoubleRight,
  mdiChevronDown,
  mdiChevronLeft,
  mdiChevronRight,
  mdiChevronUp,
  mdiCircle,
  mdiCircleOutline,
  mdiCircleSlice8,
  mdiClose,
  mdiCloseCircle,
  mdiCloseThick,
  mdiHeart,
  mdiHeartOutline,
  mdiMenuDown,
  mdiMenuUp,
  mdiPageFirst,
  mdiPageLast,
  mdiSquareOutline,
  mdiStar,
  mdiStarOutline,
} from '@mdi/js';
import { h } from 'vue';
import type { IconProps, IconSet } from 'vuetify';
import { mdi } from 'vuetify/iconsets/mdi-svg';

export const THEME_ICONS: Readonly<Record<string, string>> = {
  'mdi-arrow-down': mdiArrowDown,
  'mdi-arrow-left-bold': mdiArrowLeftBold,
  'mdi-arrow-right-bold': mdiArrowRightBold,
  'mdi-arrow-up': mdiArrowUp,
  'mdi-check-bold': mdiCheckBold,
  'mdi-check-circle': mdiCheckCircle,
  'mdi-check-circle-outline': mdiCheckCircleOutline,
  'mdi-checkbox-blank-outline': mdiCheckboxBlankOutline,
  'mdi-checkbox-marked': mdiCheckboxMarked,
  'mdi-checkbox-marked-circle': mdiCheckboxMarkedCircle,
  'mdi-checkbox-marked-outline': mdiCheckboxMarkedOutline,
  'mdi-chevron-double-left': mdiChevronDoubleLeft,
  'mdi-chevron-double-right': mdiChevronDoubleRight,
  'mdi-chevron-down': mdiChevronDown,
  'mdi-chevron-left': mdiChevronLeft,
  'mdi-chevron-right': mdiChevronRight,
  'mdi-chevron-up': mdiChevronUp,
  'mdi-circle': mdiCircle,
  'mdi-circle-outline': mdiCircleOutline,
  'mdi-circle-slice-8': mdiCircleSlice8,
  'mdi-close': mdiClose,
  'mdi-close-circle': mdiCloseCircle,
  'mdi-close-thick': mdiCloseThick,
  'mdi-heart': mdiHeart,
  'mdi-heart-outline': mdiHeartOutline,
  'mdi-menu-down': mdiMenuDown,
  'mdi-menu-up': mdiMenuUp,
  'mdi-page-first': mdiPageFirst,
  'mdi-page-last': mdiPageLast,
  'mdi-square-outline': mdiSquareOutline,
  'mdi-star': mdiStar,
  'mdi-star-outline': mdiStarOutline,
};

export function toSvgIcon<T>(icon: T): T | string {
  return typeof icon === 'string' ? (THEME_ICONS[icon] ?? icon) : icon;
}

export const mdiSvgNamed: IconSet = {
  component: (props: IconProps) =>
    h(mdi.component, props.icon === undefined ? props : { ...props, icon: toSvgIcon(props.icon) }),
};
