"use client";

import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { MotionConfig } from "motion/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={defaultSystem}><MotionConfig reducedMotion="user">{children}</MotionConfig></ChakraProvider>;
}
