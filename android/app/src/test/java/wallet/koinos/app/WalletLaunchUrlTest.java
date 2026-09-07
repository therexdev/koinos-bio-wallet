package wallet.koinos.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class WalletLaunchUrlTest {
    private static final String BASE = "https://wallet.usekoinos.com/android/";

    @Test public void purchaseAndArbitraryUrlsCannotReplaceTheWalletSurface() {
        String[] inputs = { null, "https://wallet.usekoinos.com/?tab=convert",
            "https://wallet.usekoinos.com/?source=pwa", "https://wallet.usekoinos.com/api/fund/start",
            "https://wallet.usekoinos.com/android/?tab=convert", "https://evil.example/?open=send",
            "http://wallet.usekoinos.com/?open=send", "javascript:alert(1)", "not a uri",
            "https://wallet.usekoinos.com:444/?open=send", "https://other@wallet.usekoinos.com/?open=send" };
        for (String incoming : inputs) assertEquals(incoming, BASE, WalletLaunchUrl.resolve(BASE, incoming));
    }

    @Test public void onlySupportedWalletIntentsAreCarriedForward() {
        assertEquals(BASE + "?open=receive", WalletLaunchUrl.resolve(BASE, "https://wallet.usekoinos.com/?open=receive"));
        assertEquals(BASE + "?open=send", WalletLaunchUrl.resolve(BASE, BASE + "?open=send&tab=convert"));
        assertEquals(BASE + "?tab=security", WalletLaunchUrl.resolve(BASE, BASE + "?tab=security"));
        assertEquals(BASE + "?open=send", WalletLaunchUrl.resolve(BASE, BASE + "?open=%73end"));
        assertEquals(BASE, WalletLaunchUrl.resolve(BASE, BASE + "?open=send%26tab%3Dconvert"));
    }
}
