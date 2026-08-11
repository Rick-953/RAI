package sarl.rick.rai.data

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.json.JSONObject
import sarl.rick.rai.model.SessionSecrets

/** Keeps bearer and refresh material encrypted at rest with an Android Keystore key. */
class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PreferencesName, Context.MODE_PRIVATE)

    @Synchronized
    fun load(): SessionSecrets? {
        val encodedIv = preferences.getString(IvKey, null) ?: return null
        val encodedCiphertext = preferences.getString(CiphertextKey, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(Transformation)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), gcmSpec(encodedIv))
            val plaintext = cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP))
            val value = JSONObject(String(plaintext, StandardCharsets.UTF_8))
            SessionSecrets(
                accessToken = value.getString("accessToken"),
                expiresAt = value.getLong("expiresAt"),
                refreshCookie = value.getString("refreshCookie")
            )
        }.getOrElse {
            clear()
            null
        }
    }

    @Synchronized
    @SuppressLint("ApplySharedPref", "UseKtx")
    fun save(secrets: SessionSecrets) {
        val payload = JSONObject()
            .put("accessToken", secrets.accessToken)
            .put("expiresAt", secrets.expiresAt)
            .put("refreshCookie", secrets.refreshCookie)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance(Transformation)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(payload)
        preferences.edit()
            .putString(IvKey, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(CiphertextKey, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .commit()
    }

    @Synchronized
    @SuppressLint("ApplySharedPref", "UseKtx")
    fun clear() {
        preferences.edit().clear().commit()
    }

    private fun gcmSpec(encodedIv: String): javax.crypto.spec.GCMParameterSpec =
        javax.crypto.spec.GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP))

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KeyStoreProvider).apply { load(null) }
        (keyStore.getKey(KeyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KeyStoreProvider).apply {
            init(
                KeyGenParameterSpec.Builder(
                    KeyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
        }.generateKey()
    }

    private companion object {
        const val PreferencesName = "rai_secure_session_v1"
        const val KeyAlias = "sarl.rick.rai.session.v1"
        const val KeyStoreProvider = "AndroidKeyStore"
        const val Transformation = "AES/GCM/NoPadding"
        const val IvKey = "iv"
        const val CiphertextKey = "ciphertext"
    }
}
