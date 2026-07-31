export class AgentOfficeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends AgentOfficeError {}

export class TaskNotFoundError extends AgentOfficeError {}

export class AdapterError extends AgentOfficeError {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

export class LockTimeoutError extends AgentOfficeError {}
