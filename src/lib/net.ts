/**
 * 带重试的 fetch。
 *
 * @why 线上网关对同一路径会间歇性返回 404（实测连续三次请求得到 200/404/200）。
 *      索引文件只有几百 KB，丢一次整页就白屏，重试成本远低于白屏。
 * @constraint 只用于「必须成功」的关键资源。像 blockstates 探测这类
 *      404 本身就是有效结果的请求不能套这层，否则会把"不存在"也重试三遍。
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempt = 0,
): Promise<Response> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`请求失败 ${response.status}：${url}`)
    return response
  } catch (error) {
    if (attempt >= 3) throw error
    await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)))
    return fetchWithRetry(url, init, attempt + 1)
  }
}
