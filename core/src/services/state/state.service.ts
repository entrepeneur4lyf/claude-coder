import Anthropic from "@anthropic-ai/sdk"
import fs from "fs/promises"
import path from "path"
import { findLastIndex, combineApiRequests, combineCommandSequences, getApiMetrics } from "@/utils"
import { ClaudeMessage, KoduDevOptions, KoduDevState } from "@/types"

export const DEFAULT_MAX_REQUESTS_PER_TASK = 20

export class StateService {
	private _state: KoduDevState
	private _maxRequestsPerTask: number
	private _alwaysAllowReadOnly: boolean
	private _creativeMode: "creative" | "normal" | "deterministic"
	private _customInstructions?: string
	private _alwaysAllowWriteOnly: boolean
	private _experimentalTerminal?: boolean
	private _autoCloseTerminal?: boolean
	private _skipWriteAnimation?: boolean
	private _globalStoragePath?: string
	constructor(options: KoduDevOptions) {
		const {
			maxRequestsPerTask,
			customInstructions,
			alwaysAllowReadOnly,
			alwaysAllowWriteOnly,
			historyItem,
			creativeMode,
			experimentalTerminal,
			autoCloseTerminal,
			skipWriteAnimation,
			globalStoragePath,
		} = options
		this._creativeMode = creativeMode ?? "normal"
		this._alwaysAllowReadOnly = alwaysAllowReadOnly ?? false
		this._alwaysAllowWriteOnly = alwaysAllowWriteOnly ?? false
		this._customInstructions = customInstructions
		this._maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK
		this._experimentalTerminal = experimentalTerminal
		this._autoCloseTerminal = autoCloseTerminal
		this._skipWriteAnimation = skipWriteAnimation
		this._globalStoragePath = globalStoragePath

		this._state = {
			taskId: historyItem ? historyItem.id : Date.now().toString(),
			dirAbsolutePath: historyItem?.dirAbsolutePath ?? "",
			isRepoInitialized: historyItem?.isRepoInitialized ?? false,
			requestCount: 0,
			memory: historyItem?.memory,
			apiConversationHistory: [],
			claudeMessages: [],
			abort: false,
		}
	}

	public popLastClaudeMessage(): ClaudeMessage | undefined {
		return this.state.claudeMessages.pop()
	}

	public popLastApiConversationMessage(): Anthropic.MessageParam | undefined {
		return this.state.apiConversationHistory.pop()
	}

	// Getter methods for read-only access
	get state(): KoduDevState {
		return this._state
	}

	get autoCloseTerminal(): boolean | undefined {
		return this._autoCloseTerminal
	}

	get customInstructions(): string | undefined {
		return this._customInstructions
	}

	get taskId(): string {
		return this.taskId
	}

	get dirAbsolutePath(): string | undefined {
		return this.state.dirAbsolutePath
	}

	get isRepoInitialized(): boolean {
		return this.state.isRepoInitialized ?? false
	}

	get experimentalTerminal(): boolean | undefined {
		return this._experimentalTerminal
	}

	get maxRequestsPerTask(): number {
		return this._maxRequestsPerTask
	}

	get alwaysAllowReadOnly(): boolean {
		return this._alwaysAllowReadOnly
	}

	get creativeMode(): "creative" | "normal" | "deterministic" {
		return this._creativeMode
	}

	get alwaysAllowWriteOnly(): boolean {
		return this._alwaysAllowWriteOnly
	}

	get skipWriteAnimation(): boolean | undefined {
		return this._skipWriteAnimation
	}

	// Methods to modify the properties (only accessible within the class)
	public setState(newState: KoduDevState): void {
		this._state = newState
	}

	public setSkipWriteAnimation(newValue: boolean | undefined) {
		this._skipWriteAnimation = newValue
	}

	get historyErrors(): KoduDevState["historyErrors"] | undefined {
		return this.state.historyErrors
	}

	set historyErrors(newErrors: KoduDevState["historyErrors"]) {
		this.state.historyErrors = newErrors
	}

	public setHistoryErrorsEntry(key: string, value: NonNullable<KoduDevState["historyErrors"]>[string]): void {
		if (!this.state.historyErrors) {
			this.state.historyErrors = {}
		}
		this.state.historyErrors[key] = value
	}

	public getMessageById(messageId: number): ClaudeMessage | undefined {
		return this.state.claudeMessages.find((msg) => msg.ts === messageId)
	}

	public setAutoCloseTerminal(newValue: boolean): void {
		this._autoCloseTerminal = newValue
	}

	public setExperimentalTerminal(newValue: boolean): void {
		this._experimentalTerminal = newValue
	}

	public setMaxRequestsPerTask(newMax?: number): void {
		this._maxRequestsPerTask = newMax ?? DEFAULT_MAX_REQUESTS_PER_TASK
	}

	public setCustomInstructions(newInstructions?: string): void {
		this._customInstructions = newInstructions
	}

	public setAlwaysAllowReadOnly(newValue: boolean): void {
		this._alwaysAllowReadOnly = newValue
	}

	public setCreativeMode(newMode: "creative" | "normal" | "deterministic"): void {
		this._creativeMode = newMode
	}

	public setAlwaysAllowWriteOnly(newValue: boolean): void {
		this._alwaysAllowWriteOnly = newValue
	}

	private async ensureTaskDirectoryExists(): Promise<string> {
		if (!this._globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const taskDir = path.join(this._globalStoragePath, "tasks", this.state.taskId)
		await fs.mkdir(taskDir, { recursive: true })
		return taskDir
	}

	async getSavedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	async getCleanedClaudeMessages(): Promise<ClaudeMessage[]> {
		const claudeMessages = await this.getSavedClaudeMessages()
		// remove any content text from tool_result or user message or assistant message

		const mappedClaudeMessages = claudeMessages.map((message) => {
			const sanitizedMessage: ClaudeMessage = {
				...message,
				text: "[REDACTED]",
			}

			return sanitizedMessage
		})

		return mappedClaudeMessages
	}
	async getCleanedApiConversationHistory(): Promise<Anthropic.MessageParam[]> {
		// apiHistory = Anthropic.Messages.MessageParam[]
		const apiHistory = await this.getSavedApiConversationHistory()
		// remove any content text from tool_result or user message or assistant message
		const sanitizeContent = (content: Anthropic.MessageParam["content"]): string | Array<any> => {
			if (typeof content === "string") {
				return "[REDACTED]"
			} else if (Array.isArray(content)) {
				return content.map((item) => {
					if (item.type === "tool_use") {
						return { ...item, content: "[REDACTED]", input: "[REDACTED]" }
					}
					if (item.type === "text") {
						return { ...item, text: "[REDACTED]" }
					} else if (item.type === "tool_result") {
						return { ...item, content: "[REDACTED]" }
					} else if (item.type === "image") {
						// Preserve image blocks without modification
						return item
					}
					return item
				})
			}
			return content
		}

		const mappedApiHistory = apiHistory.map((message) => {
			const sanitizedMessage: Anthropic.MessageParam = {
				...message,
				content: sanitizeContent(message.content),
			}

			return sanitizedMessage
		})

		return mappedApiHistory
	}

	public addErrorPath(errorPath: string): void {
		// push a new key to the historyErrors object
		if (!this.state.historyErrors) {
			this.state.historyErrors = {}
		}
		this.state.historyErrors[errorPath] = {
			lastCheckedAt: -1,
			error: "",
		}
	}

	async addToApiConversationHistory(message: Anthropic.MessageParam) {
		this.state.apiConversationHistory.push(message)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {
		this.state.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	async saveApiConversationHistory() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "api_conversation_history.json")
			await fs.writeFile(filePath, JSON.stringify(this.state.apiConversationHistory))
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
		}
	}

	async getSavedClaudeMessages(): Promise<ClaudeMessage[]> {
		const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
		const fileExists = await fs
			.access(filePath)
			.then(() => true)
			.catch(() => false)
		if (fileExists) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
		return []
	}

	async removeEverythingAfterMessage(messageId: number) {
		const index = this.state.claudeMessages.findIndex((msg) => msg.ts === messageId)
		if (index === -1) {
			console.error(`[StateManager] removeEverythingAfterMessage: Message with id ${messageId} not found`)
			return
		}
		console.log(
			`[StateManager] removeEverythingAfterMessage: Removing everything after message with id ${messageId}`
		)
		this.state.claudeMessages = this.state.claudeMessages.slice(0, index + 1)
		await this.saveClaudeMessages()
	}

	async updateClaudeMessage(messageId: number, message: ClaudeMessage) {
		const index = this.state.claudeMessages.findIndex((msg) => msg.ts === messageId)
		if (index === -1) {
			console.error(`[StateManager] updateClaudeMessage: Message with id ${messageId} not found`)
			return
		}
		this.state.claudeMessages[index] = message
		await this.saveClaudeMessages()
	}

	async appendToClaudeMessage(messageId: number, text: string) {
		const lastMessage = this.state.claudeMessages.find((msg) => msg.ts === messageId)
		if (lastMessage && lastMessage.type === "say") {
			lastMessage.text += text
		}
		// too heavy to save every chunk we should save the whole message at the end
		await this.saveClaudeMessages()
	}

	async addToClaudeAfterMessage(messageId: number, message: ClaudeMessage) {
		const index = this.state.claudeMessages.findIndex((msg) => msg.ts === messageId)
		if (index === -1) {
			console.error(`[StateManager] addToClaudeAfterMessage: Message with id ${messageId} not found`)
			return
		}
		this.state.claudeMessages.splice(index + 1, 0, message)
		await this.saveClaudeMessages()
	}

	async addToClaudeMessages(message: ClaudeMessage) {
		this.state.claudeMessages.push(message)
		await this.saveClaudeMessages()
	}

	async overwriteClaudeMessages(newMessages: ClaudeMessage[]) {
		this.state.claudeMessages = newMessages
		await this.saveClaudeMessages()
	}

	/**
	 * rewrite required.
	 *
	 * @deprecated
	 */
	async saveClaudeMessages() {
		try {
			const filePath = path.join(await this.ensureTaskDirectoryExists(), "claude_messages.json")
			await fs.writeFile(filePath, JSON.stringify(this.state.claudeMessages))
			const apiMetrics = getApiMetrics(
				combineApiRequests(combineCommandSequences(this.state.claudeMessages.slice(1)))
			)
			const taskMessage = this.state.claudeMessages[0]
			const lastRelevantMessage =
				this.state.claudeMessages[
					findLastIndex(
						this.state.claudeMessages,
						(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
					)
				]

			// @TODO: refactor this to use the new state manager
			// await this.providerRef
			// 	.deref()
			// 	?.getStateManager()
			// 	.updateTaskHistory({
			// 		id: this.state.taskId,
			// 		ts: lastRelevantMessage.ts,
			// 		task: taskMessage.text ?? "",
			// 		tokensIn: apiMetrics.totalTokensIn,
			// 		tokensOut: apiMetrics.totalTokensOut,
			// 		cacheWrites: apiMetrics.totalCacheWrites,
			// 		cacheReads: apiMetrics.totalCacheReads,
			// 		totalCost: apiMetrics.totalCost,
			// 	})
		} catch (error) {
			console.error("Failed to save claude messages:", error)
		}
	}
}
