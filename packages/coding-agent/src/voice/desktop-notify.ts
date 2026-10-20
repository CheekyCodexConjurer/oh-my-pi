/**
 * Windows toast for a pending question.
 *
 * The terminal dialog is the visual fallback, but it is invisible while the
 * window is minimized, so a spoken question also raises a desktop toast. Text
 * travels base64-encoded into the PowerShell script: the payload never becomes
 * part of the command source, so a question cannot inject script.
 */
import { spawn } from "node:child_process";

const MAX_TITLE = 80;
const MAX_BODY = 360;

function toBase64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/** Whether desktop toasts are allowed on this host. */
export function canShowToast(): boolean {
	return process.platform === "win32" && process.env.OMP_VOICE_ASK_NOTIFY !== "0";
}

/** Fire-and-forget toast; failures are silent because the dialog still exists. */
export function notifyPendingQuestion(question: string, details?: string): void {
	if (!canShowToast()) return;
	const title = toBase64("OMP pergunta".slice(0, MAX_TITLE));
	const body = toBase64(`${question}${details ? `\n${details}` : ""}`.slice(0, MAX_BODY));
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null",
		`$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${title}'))`,
		`$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}'))`,
		"$esc=[Security.SecurityElement]::Escape",
		'$xml="<toast><visual><binding template=\\"ToastGeneric\\"><text>" + $esc.Invoke($t) + "</text><text>" + $esc.Invoke($b) + "</text></binding></visual></toast>"',
		"$doc=New-Object Windows.Data.Xml.Dom.XmlDocument",
		"$doc.LoadXml($xml)",
		"$toast=New-Object Windows.UI.Notifications.ToastNotification $doc",
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.PowerShell').Show($toast)",
	].join("; ");
	try {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
			{
				stdio: "ignore",
				windowsHide: true,
				detached: true,
			},
		);
		// A spawn failure arrives as an async 'error' event, which the try/catch
		// cannot see; without a listener Node would take the whole CLI down.
		child.on("error", () => {});
		child.unref();
	} catch {
		// A missing PowerShell or a blocked toast is not worth failing a question.
	}
}
