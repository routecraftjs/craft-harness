---
name: scheduling
description: How to schedule work for later and how it comes back. Use when something needs doing at a time other than now.
---

# Scheduling

`schedule-task` writes a line to a file. `scheduler-tick`, on its own cron,
reads that file and sends you the message you wrote. That is the whole
mechanism, and knowing it is the mechanism tells you what it can and cannot
promise.

## Write the message to a stranger

You will not remember scheduling it. What arrives is the text you wrote,
delivered into a conversation, and the only other thing you will have is
that conversation's transcript.

So write the whole thought:

> Bad: "check on the migration"
> Good: "Check whether the users-table migration finished. It was started on
> the 3rd, the log is at workspace/migrations/users.log, and Priya asked to
> be told either way."

## Say when, in minutes

Use `inMinutes`. You have no clock, and an absolute timestamp you calculated
is an absolute timestamp you guessed. `dueAt` exists for a caller who does
know the exact moment.

## What it does not promise

The tick runs on a schedule, so a task fires on the first tick after it comes
due, not at the second it comes due. Do not use this for anything where a
minute matters.

A task that fires while the process is down fires when the process comes
back, because the file outlived the process. Nothing is lost; it is late.

## Cleaning up

`list-schedules` shows what is pending. `cancel-schedule` drops one by id.
Cancel a task the moment it stops being needed: a reminder about something
already done is worse than no reminder, because whoever reads it has to work
out which.
