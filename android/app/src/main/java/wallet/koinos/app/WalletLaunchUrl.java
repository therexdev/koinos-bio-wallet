package wallet.koinos.app;

import java.net.URI;
import java.net.URLDecoder;

/** Every APK entry point stays on the wallet-only page, including old pins. */
public final class WalletLaunchUrl {
    private WalletLaunchUrl() {}

    public static String resolve(String base, String incoming) {
        try {
            URI home = new URI(base);
            URI intent = incoming == null ? null : new URI(incoming);
            if (intent == null || !"https".equalsIgnoreCase(intent.getScheme())
                    || !home.getHost().equalsIgnoreCase(intent.getHost())
                    || intent.getRawUserInfo() != null
                    || (intent.getPort() != -1 && intent.getPort() != 443)) return base;
            String query = intent.getRawQuery();
            if (query == null) return base;
            for (String field : query.split("&")) {
                String[] pair = field.split("=", 2);
                if (pair.length != 2) continue;
                String key = URLDecoder.decode(pair[0], "UTF-8");
                String value = URLDecoder.decode(pair[1], "UTF-8");
                if ("open".equals(key) && ("receive".equals(value) || "send".equals(value))) {
                    return base + "?open=" + value;
                }
                if ("tab".equals(key) && "security".equals(value)) return base + "?tab=security";
            }
        } catch (Exception ignored) {
            // Invalid input cannot change the configured destination.
        }
        return base;
    }
}
