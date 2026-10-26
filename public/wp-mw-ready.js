/* Fusion web proxy (TT39, WP-11): imported first by an emulated module worker's wrapper, so it runs exactly when the
   site's module graph begins evaluating — the moment a native module worker starts delivering messages. */
if (typeof self.__fwRelease === "function") self.__fwRelease();
