import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async validateGitHubUser(githubId: string, profile: any) {
    let user = await this.prisma.user.findUnique({
      where: { githubId },
    });

    if (!user) {
      const email = profile.emails?.[0]?.value || `${profile.username}@users.noreply.github.com`;

      // Check if a user with this email already exists
      const existingUserByEmail = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingUserByEmail) {
        // Email user exists but githubId is different - check if githubId is taken by another user
        const existingUserByGithubId = await this.prisma.user.findUnique({
          where: { githubId },
        });

        if (existingUserByGithubId) {
          // Another user already has this githubId - use that account instead
          user = existingUserByGithubId;
        } else {
          // Update existing email user with GitHub info (githubId is available)
          user = await this.prisma.user.update({
            where: { email },
            data: {
              githubId,
              name: profile.displayName || profile.username,
              avatar: profile._json?.avatar_url,
              githubLogin: profile.username,
              githubBio: profile._json?.bio,
              githubLocation: profile._json?.location,
              githubBlog: profile._json?.blog,
            },
          });
        }
      } else {
        // Create new user
        user = await this.prisma.user.create({
          data: {
            githubId,
            name: profile.displayName || profile.username,
            email,
            avatar: profile._json?.avatar_url,
            githubLogin: profile.username,
            githubBio: profile._json?.bio,
            githubLocation: profile._json?.location,
            githubBlog: profile._json?.blog,
          },
        });
      }

      // Only create settings if user was just created (not updated)
      if (!existingUserByEmail) {
        // Create default settings
        await this.prisma.settings.create({
          data: {
            userId: user.id,
            theme: 'miami-vice',
            chatModel: 'gpt-4',
            displayName: profile.displayName || profile.username,
          },
        });
      }
    } else {
      // Update user info
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          name: profile.displayName || profile.username,
          avatar: profile._json?.avatar_url,
          githubBio: profile._json?.bio,
          githubLocation: profile._json?.location,
          githubBlog: profile._json?.blog,
        },
      });
    }

    return this.generateToken(user);
  }

  async generateToken(user: any) {
    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        githubLogin: user.githubLogin,
      },
    };
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { settings: true },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  async createDemoUser() {
    const demoEmail = 'demo@goals-af.com';

    // Check if demo user already exists
    let user = await this.prisma.user.findUnique({
      where: { email: demoEmail },
    });

    if (!user) {
      // Create demo user
      user = await this.prisma.user.create({
        data: {
          email: demoEmail,
          name: 'Demo User',
          avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=face',
        },
      });

      // Create default settings
      await this.prisma.settings.create({
        data: {
          userId: user.id,
          theme: 'miami-vice',
          chatModel: 'gpt-4',
          displayName: 'Demo User',
        },
      });
    }

    return this.generateToken(user);
  }

  // ============ Email/Password Authentication Methods ============

  /**
   * Validate password strength
   * Requirements: Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
   */
  validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    if (!/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Hash password using bcrypt
   */
  private async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Compare password with hash
   */
  private async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Validate email format
   */
  private validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Register a new user with email and password
   * Sends verification email - user cannot login until email is verified
   */
  async register(email: string, password: string, name: string) {
    // Validate email format
    if (!this.validateEmail(email)) {
      throw new BadRequestException('Invalid email format');
    }

    // Validate password strength
    const passwordValidation = this.validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      throw new BadRequestException({
        message: 'Password does not meet requirements',
        errors: passwordValidation.errors,
      });
    }

    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const passwordHash = await this.hashPassword(password);

    // Generate email verification token
    const verificationToken = Math.random().toString(36).substring(2, 15) +
                              Math.random().toString(36).substring(2, 15);
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user (email not verified yet)
    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        resetPasswordToken: verificationToken, // Using resetPasswordToken for email verification
        resetPasswordExpires: verificationExpires,
      },
    });

    // Create default settings
    await this.prisma.settings.create({
      data: {
        userId: user.id,
        theme: 'miami-vice',
        chatModel: 'gpt-4',
        displayName: name,
      },
    });

    // TODO: Send verification email via Mailgun
    // Email should contain: `${FRONTEND_URL}/auth/verify-email?token=${verificationToken}`

    // Return verification info (in dev mode, return token for testing)
    if (this.config.get<string>('NODE_ENV') === 'development') {
      return {
        message: 'Registration successful. Please check your email to verify your account.',
        userId: user.id,
        verificationToken, // Only in development for testing
      };
    }

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: user.id,
    };
  }

  /**
   * Validate credentials for local strategy
   * Returns user without password hash if valid, null otherwise
   */
  async validateCredentials(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      // Increment failed attempts for email enumeration protection
      if (user) {
        await this.incrementFailedLogin(email);
      }
      return null;
    }

    // Check if email is verified
    if (!user.emailVerified) {
      throw new UnauthorizedException('Please verify your email before logging in');
    }

    // Check if account is locked
    if (user.lockUntil && user.lockUntil > new Date()) {
      return null;
    }

    const isPasswordValid = await this.comparePassword(password, user.passwordHash);

    if (!isPasswordValid) {
      await this.incrementFailedLogin(email);
      return null;
    }

    // Clear failed attempts on successful login
    await this.resetFailedLogin(email);

    return user;
  }

  /**
   * Login with email and password
   */
  async loginWithEmail(email: string, password: string) {
    const user = await this.validateCredentials(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Check if account is locked
    if (user.lockUntil && user.lockUntil > new Date()) {
      throw new UnauthorizedException(
        `Account locked. Try again after ${user.lockUntil.toLocaleString()}`
      );
    }

    return this.generateToken(user);
  }

  /**
   * Increment failed login attempts and lock account if necessary
   */
  private async incrementFailedLogin(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) return;

    const failedAttempts = (user.failedLoginAttempts || 0) + 1;

    // Lock account after 5 failed attempts for 30 minutes
    const lockUntil = failedAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;

    await this.prisma.user.update({
      where: { email },
      data: {
        failedLoginAttempts: failedAttempts,
        lockUntil,
      },
    });
  }

  /**
   * Reset failed login attempts on successful login
   */
  private async resetFailedLogin(email: string) {
    await this.prisma.user.update({
      where: { email },
      data: {
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });
  }

  /**
   * Initiate password reset
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration
    if (!user || !user.passwordHash) {
      return { message: 'If an account exists with this email, a password reset link will be sent' };
    }

    // Generate reset token (in production, send email with token)
    const resetToken = Math.random().toString(36).substring(2, 15) +
                      Math.random().toString(36).substring(2, 15);
    const resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.user.update({
      where: { email },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires,
      },
    });

    // TODO: Send email with reset link
    // For now, return the token in development only
    if (this.config.get<string>('NODE_ENV') === 'development') {
      return {
        message: 'Password reset token generated (development mode)',
        resetToken,
      };
    }

    return { message: 'If an account exists with this email, a password reset link will be sent' };
  }

  /**
   * Complete password reset
   */
  async resetPassword(token: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: {
          gte: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Validate password strength
    const passwordValidation = this.validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      throw new BadRequestException({
        message: 'Password does not meet requirements',
        errors: passwordValidation.errors,
      });
    }

    // Hash new password
    const passwordHash = await this.hashPassword(newPassword);

    // Update password and clear reset token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExpires: null,
        failedLoginAttempts: 0,
        lockUntil: null,
      },
    });

    return { message: 'Password reset successfully' };
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        resetPasswordToken: token, // Using resetPasswordToken for email verification
        resetPasswordExpires: {
          gte: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    // Mark email as verified and clear verification token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: new Date(),
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    // Return login token for immediate login after verification
    return this.generateToken(user);
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration
    if (!user || !user.passwordHash) {
      return { message: 'If an account exists with this email, a verification link will be sent' };
    }

    // If already verified, no need to resend
    if (user.emailVerified) {
      return { message: 'Email is already verified' };
    }

    // Generate new verification token
    const verificationToken = Math.random().toString(36).substring(2, 15) +
                              Math.random().toString(36).substring(2, 15);
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.prisma.user.update({
      where: { email },
      data: {
        resetPasswordToken: verificationToken,
        resetPasswordExpires: verificationExpires,
      },
    });

    // TODO: Send verification email via Mailgun
    // Email should contain: `${FRONTEND_URL}/auth/verify-email?token=${verificationToken}`

    // Return verification info (in dev mode, return token for testing)
    if (this.config.get<string>('NODE_ENV') === 'development') {
      return {
        message: 'Verification email sent',
        verificationToken, // Only in development for testing
      };
    }

    return { message: 'Verification email sent' };
  }
}
