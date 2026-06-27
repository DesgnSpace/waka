# Contributing to Waka

Thank you for your interest in contributing to Waka! This document provides guidelines and instructions for contributing.

## 🚀 Quick Start

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone <your-repo-url>
   cd waka
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set up your environment** following the [README.md](README.md) Quick Start guide
5. **Start development**:
   ```bash
   npm run dev
   ```

## 🐛 Reporting Issues

When reporting bugs, please include:

- **Environment details**: Node.js version, OS, browser (if applicable)
- **Steps to reproduce**: Clear, numbered steps
- **Expected behavior**: What you expected to happen
- **Actual behavior**: What actually happened
- **Error messages**: Full error logs (sanitize sensitive info)
- **Configuration**: Relevant environment variables (mask secrets)

### Bug Report Template

```markdown
**Environment:**

- Node.js version:
- OS:
- Waka version:

**Steps to Reproduce:**

1.
2.
3.

**Expected Behavior:**

**Actual Behavior:**

**Error Messages:**
```

## ✨ Feature Requests

Before submitting a feature request:

1. **Check existing issues** to avoid duplicates
2. **Describe the problem** you're trying to solve
3. **Explain your proposed solution**
4. **Consider alternatives** you've evaluated
5. **Estimate complexity** if possible

## 🔧 Development Guidelines

### Code Style

- **TypeScript**: Use strict types, avoid `any`
- **React**: Use functional components with hooks
- **Formatting**: We use Prettier (run `npm run lint`)
- **Naming**: Use descriptive variable/function names
- **Comments**: Explain complex logic, not obvious code

### Architecture Principles

- **API Compatibility**: Maintain Resend SDK compatibility
- **Security First**: Validate all inputs, sanitize outputs
- **Database**: Use Supabase RLS policies for security
- **Error Handling**: Graceful degradation with informative messages
- **Testing**: Test all new features thoroughly

### File Organization

```
src/
├── app/api/           # Next.js API routes
├── components/        # Reusable UI components
├── contexts/          # React context providers
├── lib/               # Core business logic
│   ├── supabase.ts    # Database operations
│   ├── ses.ts         # Email sending logic
│   ├── domains.ts     # Domain management
│   └── middleware.ts  # API middleware
```

## 🧪 Testing

### Running Tests

```bash
# Lint code
npm run lint

# Type checking
npm run type-check
```

### Writing Tests

- **API endpoints**: Test success and error cases
- **Email sending**: Verify integration with SES
- **Domain setup**: Test DNS record generation
- **Authentication**: Test JWT and API key validation

## 🚀 Pull Request Process

### Before Submitting

1. **Create a feature branch**: `git checkout -b feature/your-feature-name`
2. **Test thoroughly**: Ensure all functionality works
3. **Update documentation**: Add/update relevant docs
4. **Follow code style**: Run linting and formatting
5. **Write clear commits**: Use descriptive commit messages

### PR Description Template

```markdown
## Changes Made

-
-
-

## Testing

- [ ] Tested new functionality manually
- [ ] Updated documentation
- [ ] No breaking changes (or documented)

## Screenshots

(If applicable)

## Notes

(Any additional context)
```

### Review Process

1. **Automated checks**: Must pass CI/CD pipeline
2. **Code review**: Maintainer will review code quality
3. **Testing**: Verify functionality works as expected
4. **Documentation**: Ensure docs are updated
5. **Merge**: Once approved, PR will be merged

## 🎯 Good First Issues

Looking for ways to contribute? Check for issues labeled:

- `good first issue`: Perfect for newcomers
- `help wanted`: Community help appreciated
- `documentation`: Improve docs
- `bug`: Fix existing issues

## 🛠️ Development Setup Tips

### Environment Variables

Create `.env.local` from `.env.local.example`:

```bash
cp .env.local.example .env.local
```

**Required for development:**

- Supabase credentials (database)
- AWS SES credentials (email sending)
- Admin credentials (initial setup)

**Optional:**

- Digital Ocean token (DNS automation)

### Common Development Tasks

```bash
# Reset database (be careful!)
# Only in development - never in production
npm run db:reset

# View logs
npm run dev | grep -E "(error|warn)"

# Build for production
npm run build
```

### Debugging Tips

1. **Check logs**: Browser console + terminal output
2. **Verify environment**: All required env vars set?
3. **Test connectivity**: Can you reach Supabase/AWS?
4. **Email delivery**: Check AWS SES console for failures
5. **DNS issues**: Use `dig` to verify DNS records

## 📚 Learning Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [AWS SES Documentation](https://docs.aws.amazon.com/ses/)
- [Resend API Documentation](https://resend.com/docs)

## ❓ Getting Help

- **Documentation**: Check README.md and SETUP.md first
- **Issues**: Search existing GitHub issues
- **Discussions**: Use GitHub Discussions for questions
- **Code Review**: Ask for feedback on draft PRs


## 🙏 Recognition

Contributors will be:

- Listed in README.md
- Credited in release notes
- Recognized in the community

Thank you for helping make Waka better! 🚀

---

**Waka** was originally created by **[Emad Ibrahim](https://github.com/eibrahim)**. This fork continues the project under the MIT license.
