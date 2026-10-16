# Launch from a GitHub URL

Open **New machine**, choose **Paste GitHub URL**, paste a supported URL, and choose **Review URL**. Review the repository, source, exact commit and pull-request target base before choosing **Launch machine**. Reviewing a URL does not start a machine or run repository setup.

Supported URL forms:

```text
https://github.com/OWNER/REPOSITORY
https://github.com/OWNER/REPOSITORY/tree/BRANCH
https://github.com/OWNER/REPOSITORY/commit/FULL_40_CHARACTER_COMMIT_ID
https://github.com/OWNER/REPOSITORY/pull/NUMBER
```

A repository URL uses its default branch. A branch URL must name the whole branch, including any slashes; file and directory links are unsupported. A commit URL uses the repository's default branch as the future PR target. A same-repository PR URL starts from its head commit and uses its base branch as the future PR target. The new machine always gets its own session branch; it does not write to the source branch or update the original PR.

Only repositories available to your current GitHub identity and this application's installed GitHub App can be used. Public visibility alone does not grant launch access. Fork PRs and PRs whose source branch was deleted are unsupported in this version. A commit must be reachable from a branch in the authorized repository; an object available only through its fork network is insufficient. Use a supported source in an authorized repository instead.

The server checks the selected source and repository/installation identity again on confirmation. If its commit or target base branch changed, refresh the review before launching. Accepted machines clone the reviewed commit even if a branch moves later. A missing commit fails provisioning and enters the existing cleanup flow; the app never substitutes the current branch head. Git pushes remain restricted to the assigned session branch. Resolution has time, request-count and response-size limits; large comparisons or complex branch histories can require choosing a branch URL instead.

Use a plain HTTPS `github.com` URL without a username, password, port, query or fragment. Links to files, issues, GitHub Enterprise hosts and other Git services are unsupported. URLs never supply API credentials or override repository authorization.

## Recovery

If a launch response is lost, check the machine list or retry the saved request. The retry retains the same request ID and reviewed commit so it can recover the same machine. Do not assume a timeout means no machine was created. Browser session storage is required to save this recovery request before sending it.

The usual one-active-machine limit, one-hour initial lifetime, fresh Codex sign-in, explicit setup execution and cleanup behavior apply. See [the usage guide](USAGE.md) and [reference](REFERENCE.md#workflow).

## Try it without accounts

`npm run local` uses synthetic URL fixtures and never contacts GitHub or E2B. Use `https://github.com/ephemeral/example-app`, its `main`, `develop` or `feature/demo` branch, or PR `/pull/1`. Review and launch are labeled simulation; displayed commits and cleanup outcomes are not evidence of real GitHub access or provider verification.

This release accepts pasted URLs in the launch dialog. Browser extensions, external launch links and automatic launching are not included.
