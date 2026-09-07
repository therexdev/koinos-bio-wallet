package wallet.koinos.app;

import android.net.Uri;
import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** Keeps the same browser origin and passkeys while removing conversion UI. */
public class WalletLauncherActivity extends LauncherActivity {
    @Override
    protected Uri getLaunchingUrl() {
        Uri incoming = getIntent() == null ? null : getIntent().getData();
        return Uri.parse(WalletLaunchUrl.resolve(getString(R.string.launch_url),
                incoming == null ? null : incoming.toString()));
    }
}
