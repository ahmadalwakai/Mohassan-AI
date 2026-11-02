"use client";

import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";
import type { ReactNode } from "react";

const system = createSystem(defaultConfig, {
  theme: {
    tokens: {
      fonts: {
        body: { value: '"Segoe UI", Tahoma, Arial, sans-serif' },
        heading: { value: '"Segoe UI", Tahoma, Arial, sans-serif' },
      },
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
