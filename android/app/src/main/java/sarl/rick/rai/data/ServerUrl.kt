package sarl.rick.rai.data

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerUrl {
    const val Default = "https://rai.rick.sarl"

    private val developmentHosts = setOf("localhost", "127.0.0.1", "10.0.2.2", "::1")

    fun normalize(value: String): Result<String> = runCatching {
        var candidate = value.trim()
        require(candidate.isNotBlank()) { "请输入 RAI 服务器地址" }
        if (!candidate.contains("://")) candidate = "https://$candidate"
        val url = candidate.toHttpUrlOrNull() ?: error("服务器地址无效")
        require(url.username.isEmpty() && url.password.isEmpty()) { "服务器地址不可包含账号或密码" }
        require(url.query == null && url.fragment == null) { "服务器地址不可包含查询或片段" }
        require(url.scheme == "https" || (url.scheme == "http" && url.host in developmentHosts)) {
            "远程 RAI 服务器必须使用 HTTPS"
        }
        buildString {
            append(url.scheme)
            append("://")
            append(if (url.host.contains(':')) "[${url.host}]" else url.host)
            val defaultPort = if (url.scheme == "https") 443 else 80
            if (url.port != defaultPort) append(":${url.port}")
        }
    }
}
